/**
 * DB2 File Loader for WoW 12.0 (Midnight)
 * Based on TrinityCore's DB2FileLoader implementation
 * Supports WDC5/WDC6 formats with compression
 */

import {
  DB2Header,
  DB2SectionHeader,
  DB2ColumnMeta,
  DB2ColumnCompression,
  DB2FieldEntry,
  parseDB2Header,
  parseDB2SectionHeader,
  isValidDB2Signature,
} from './DB2Header';
import { logger } from '../../utils/logger';
import { IDB2FileSource, DB2FileSystemSource } from './DB2FileSource';
import { DB2Record } from './DB2Record';
import { DB2IdList, DB2OffsetMap, DB2CopyTable, DB2ParentLookupTable } from './DB2Tables';
import { DB2SectionManager } from './DB2SectionManager';
import { DB2SparseFieldLayout, getSparseFieldLayout } from './DB2FieldLayout';

/** WDC relationship block header: numEntries, minId, maxId. */
const PARENT_LOOKUP_HEADER_SIZE = 12;
/** One relationship entry: foreignId + recordIndex. */
const PARENT_LOOKUP_ENTRY_SIZE = 8;

export class DB2FileLoader {
  private source: IDB2FileSource | null = null;
  private header: DB2Header | null = null;
  private sections: DB2SectionHeader[] = [];
  private columnMeta: DB2ColumnMeta[] = [];
  /** Per-field pallet value tables (Pallet / PalletArray compression). */
  private palletValues: number[][] = [];
  /** Per-field record-id -> value maps (CommonData compression). */
  private commonValues: Map<number, number>[] = [];
  private fieldEntries: DB2FieldEntry[] = []; // TrinityCore-style simple field metadata
  private data: Buffer | null = null;
  private stringTable: Buffer | null = null;

  // Multi-section support (WoWDev format)
  private sectionManager: DB2SectionManager = new DB2SectionManager();
  /**
   * Field layout for this file, when it is sparse. Sparse records cannot be
   * read without one: their fields move per record. Resolved from the file
   * name at load time, or set explicitly via setSparseFieldLayout().
   */
  private sparseFieldLayout: DB2SparseFieldLayout | null = null;
  /** Name of the loaded file, used in diagnostics. */
  private fileName: string = '';
  /**
   * Section buffers, read once and reused.
   *
   * getRecord() previously re-read a whole section - every record plus its
   * string table - from disk for each lookup, which cost 190-280 ms per record
   * on Item.db2's 59,675 rows. The bytes do not change once loaded, so they are
   * cached here; total memory stays bounded by the file's own size, which is
   * still less than TrinityCore holds for the same file.
   */
  private sectionBuffers: Map<number, Buffer> = new Map();
  private copyTable: DB2CopyTable | null = null;
  private parentLookupTable: DB2ParentLookupTable | null = null;

  private rowIds = new Map<number, number>();
  private explicitSparseLayout = false;

  constructor() {}

  /**
   * Load DB2 file headers only (lightweight operation)
   * @param source File source to read from
   * @throws Error if headers are invalid
   */
  public loadHeaders(source: IDB2FileSource): void {
    if (!source.isOpen()) {
      throw new Error('DB2 file source is not open');
    }

    this.source = source;
    this.rowIds.clear();
    this.sectionManager.clear();
    this.copyTable = null;
    this.parentLookupTable = null;
    this.columnMeta = [];

    // Read header (204 bytes for WDC5/WDC6)
    const headerBuffer = Buffer.alloc(204);
    if (!source.read(headerBuffer, 204)) {
      throw new Error('Failed to read DB2 header');
    }

    this.header = parseDB2Header(headerBuffer);

    if (!isValidDB2Signature(this.header.signature)) {
      throw new Error(`Unsupported DB2 signature: ${this.header.signature}`);
    }

    // Read section headers
    this.sections = [];
    // A reload replaces the file's contents, so cached section bytes from the
    // previous load must not survive it.
    this.sectionBuffers.clear();
    for (let i = 0; i < this.header.sectionCount; i++) {
      const sectionBuffer = Buffer.alloc(40);
      if (!source.read(sectionBuffer, 40)) {
        throw new Error(`Failed to read section header ${i}`);
      }
      this.sections.push(parseDB2SectionHeader(sectionBuffer, 0));
    }
  }

  /**
   * Load full DB2 file data
   * @param source File source to read from
   * @throws Error if data cannot be loaded
   */
  public load(source: IDB2FileSource): void {
    // Load headers first
    this.loadHeaders(source);

    if (!this.header) {
      throw new Error('Headers not loaded');
    }

    // WDC3+ block order after the section headers is fixed and must be read in
    // full, even when a block is unused: field_structure, field_storage_info,
    // pallet_data, common_data. Skipping any of them leaves the file position
    // wrong for everything that follows (ID lists, copy tables, section data).
    this.loadFieldStructure(source);

    if (this.header.columnMetaSize > 0) {
      this.loadColumnMeta(source, this.header.columnMetaSize);
    }

    this.loadPalletData(source);
    this.loadCommonData(source);

    // Load ID list and offset map for ALL sections (WoWDev format)
    // This handles both sparse and dense files with section manager
    this.loadIdListAndOffsetMap(source);

    // A sparse file needs its field layout to place fields inside a record.
    // Resolve it from the file name; setSparseFieldLayout() can override.
    this.fileName = source.getFileName();
    if (!this.explicitSparseLayout) {
      this.sparseFieldLayout = getSparseFieldLayout(this.fileName);
    }

    // Load copy table if present
    this.loadCopyTable(source);

    // Load parent lookup table if present
    if (this.header.parentLookupCount > 0) {
      this.loadParentLookupTable(source);
    }
  }

  /**
   * Load from file path
   * @param filePath Path to DB2 file
   * NOTE: Keeps file source open for record retrieval
   */
  public loadFromFile(filePath: string): void {
    const source = new DB2FileSystemSource(filePath);
    this.load(source);
    // DO NOT close source - we need it for getRecord() calls!
    // The source will be stored in this.source from load()
  }

  /**
   * Get DB2 header
   * @returns Parsed header
   */
  public getHeader(): DB2Header {
    if (!this.header) {
      throw new Error('DB2 file not loaded');
    }
    return this.header;
  }

  /**
   * Get section header
   * @param section Section index
   * @returns Section header
   */
  public getSectionHeader(section: number): DB2SectionHeader {
    if (section < 0 || section >= this.sections.length) {
      throw new Error(`Invalid section index: ${section}`);
    }
    return this.sections[section];
  }

  /**
   * Get total record count across all sections
   * @returns Total records
   */
  public getRecordCount(): number {
    return this.sections.reduce((sum, section) => sum + section.recordCount, 0);
  }

  /**
   * Read one record from a sparse (offset-map) file.
   *
   * Sparse records are variable length and are addressed by the catalog rather
   * than by index, and their strings are stored inline, so each record's field
   * positions have to be walked against the table's declared field layout.
   *
   * @param recordId Record ID, which the catalog holds rather than the record
   * @param fileOffset Absolute byte offset of the record in the file
   * @param size Record length in bytes, including alignment padding
   * @returns Record accessor positioned on that record
   * @throws {Error} If no field layout is registered for the file, the read
   *   fails, or the record does not match the layout
   */
  private readSparseRecord(recordId: number, fileOffset: number, size: number): DB2Record {
    if (!this.sparseFieldLayout) {
      throw new Error(
        `${this.fileName} is a sparse DB2 file, so its records cannot be read without a field ` +
          `layout. Register one with registerSparseFieldLayout('${this.fileName}', ...).`
      );
    }

    if (!this.source || !this.source.isOpen()) {
      throw new Error('DB2 file source not available for reading record data');
    }

    if (!this.source.setPosition(fileOffset)) {
      throw new Error(`Failed to seek to sparse record ${recordId} at offset ${fileOffset}`);
    }

    const recordBuffer = Buffer.alloc(size);
    if (!this.source.read(recordBuffer, size)) {
      throw new Error(`Failed to read ${size} bytes for sparse record ${recordId}`);
    }

    const fieldOffsets = this.sparseFieldLayout.computeOffsets(recordBuffer, 0, size);

    return new DB2Record(
      recordBuffer,
      recordBuffer, // strings are inline, so the record is its own string source
      [], // column metadata describes dense records and does not apply here
      0,
      undefined, // field entries describe fixed offsets, which do not apply here
      recordId,
      true,
      size,
      1,
      fileOffset,
      0,
      this.palletValues,
      this.commonValues,
      this.header!.packedDataOffset,
      0,
      fieldOffsets
    );
  }

  /**
   * Read a section's records and string table, caching the result.
   *
   * The bytes are immutable once loaded, so the first lookup in a section pays
   * for the read and every later one is served from memory. Without this a
   * single record lookup re-read the whole section from disk.
   *
   * @param sectionIndex Section to read
   * @param recordDataSize Size of the section's record data
   * @param combinedSize Record data plus string table
   * @returns Buffer holding the section's records followed by its string table
   * @throws {Error} If the source is unavailable or the read fails
   */
  private getSectionBuffer(
    sectionIndex: number,
    recordDataSize: number,
    combinedSize: number
  ): Buffer {
    const cached = this.sectionBuffers.get(sectionIndex);
    if (cached) {
      return cached;
    }

    if (!this.source || !this.source.isOpen()) {
      throw new Error('DB2 file source not available for reading record data');
    }

    const section = this.sections[sectionIndex];
    if (!this.source.setPosition(section.fileOffset)) {
      throw new Error(`Failed to seek to section ${sectionIndex}`);
    }

    const buffer = Buffer.alloc(combinedSize);

    if (!this.source.read(buffer.subarray(0, recordDataSize), recordDataSize)) {
      throw new Error(`Failed to read section ${sectionIndex} records`);
    }

    if (section.stringTableSize > 0) {
      if (!this.source.read(buffer.subarray(recordDataSize, combinedSize), section.stringTableSize)) {
        throw new Error(`Failed to read section ${sectionIndex} string table`);
      }
    }

    this.sectionBuffers.set(sectionIndex, buffer);
    return buffer;
  }

  /**
   * Read a record by its position in the file rather than by its id.
   *
   * Two cases need this. A file whose id column is inline has no id list, so
   * nothing maps an id to a position and getRecord() cannot find anything in it
   * at all - SpellPower.db2 reported "searched 0 sections" for every id.
   * Relationship blocks also address their targets by index, so resolving an
   * index to an id only to look the id back up is a detour.
   *
   * External IDs are preserved for dense and sparse rows. Inline IDs are
   * read using the header's declared ID field.
   *
   * @param recordIndex Zero-based position across all sections, in file order
   * @returns Record accessor, or null when the index is out of range
   * @throws {Error} If the file is sparse, or the section data cannot be read
   *
   * @example
   * ```typescript
   * for (const index of loader.getParentLookupTable()!.getChildren(spellId)) {
   *   const record = loader.getRecordByIndex(index);
   * }
   * ```
   */
  public getRecordByIndex(recordIndex: number): DB2Record | null {
    if (!this.header) {
      throw new Error('DB2 file not loaded');
    }
    if (!Number.isInteger(recordIndex) || recordIndex < 0) {
      return null;
    }

    // Walk the sections to find the one holding this global index.
    let remaining = recordIndex;
    for (let sectionIndex = 0; sectionIndex < this.sections.length; sectionIndex++) {
      const section = this.sections[sectionIndex];
      if (remaining < section.recordCount) {
        const externalId = this.rowIds.get(recordIndex);
        if (this.isSparseFile()) {
          if (externalId === undefined) throw new Error(`No catalog ID for row ${recordIndex}`);
          const offset = this.sectionManager.getOffsetMapEntry(externalId);
          if (!offset) throw new Error(`No catalog entry for record ${externalId}`);
          return this.readSparseRecord(externalId, offset.offset, offset.size)
            .setIdentity(externalId, recordIndex, sectionIndex, this.parentLookupTable?.getParent(recordIndex) ?? null);
        }
        const recordDataSize = section.recordCount * this.header.recordSize;
        const combinedSize = recordDataSize + section.stringTableSize;
        const buffer = this.getSectionBuffer(sectionIndex, recordDataSize, combinedSize);

        let sectionRecordStartOffset = 0;
        let sectionStringTableStartOffset = 0;
        for (let i = 0; i < sectionIndex; i++) {
          sectionRecordStartOffset += this.sections[i].recordCount * this.header.recordSize;
          sectionStringTableStartOffset += this.sections[i].stringTableSize;
        }

        const stringOffsetCorrection =
          (section.recordCount - this.header.recordCount) * this.header.recordSize +
          sectionRecordStartOffset -
          sectionStringTableStartOffset;

        const record = new DB2Record(
          buffer,
          buffer,
          this.columnMeta,
          remaining,
          this.fieldEntries,
          externalId,
          false,
          this.header.recordSize,
          section.recordCount,
          section.fileOffset,
          stringOffsetCorrection,
          this.palletValues,
          this.commonValues,
          this.header.packedDataOffset
        );
        const id = externalId ?? record.getUInt32(this.header.indexField);
        return record.setIdentity(id, recordIndex, sectionIndex, this.parentLookupTable?.getParent(recordIndex) ?? null);
      }
      remaining -= section.recordCount;
    }

    return null;
  }

  /**
   * Set the field layout used to read this file's sparse records, overriding
   * the one resolved from the file name.
   *
   * @param layout Layout describing the file's records, or null to clear it
   */
  public setSparseFieldLayout(layout: DB2SparseFieldLayout | null): void {
    this.sparseFieldLayout = layout;
    this.explicitSparseLayout = layout !== null;
  }

  /**
   * Get record by its actual DB2 ID using the section index
   * Uses section manager to find spell across all sections
   * @param spellId DB2 record ID to retrieve
   * @returns DB2Record accessor
   */
  public getRecord(spellId: number): DB2Record {
    if (!Number.isSafeInteger(spellId) || spellId < 0) throw new Error('Record ID must be a nonnegative integer');
    let sourceId = spellId;
    const seen = new Set<number>();
    while (this.copyTable?.isCopy(sourceId)) {
      if (seen.has(sourceId)) throw new Error(`Copy-table cycle at record ${sourceId}`);
      seen.add(sourceId);
      sourceId = this.copyTable.getSourceRowId(sourceId)!;
    }
    const mapping = this.sectionManager.findSpellId(sourceId);
    if (!mapping) throw new Error(`Record ID ${spellId} not found in ${this.fileName}`);
    const rowIndex = this.sections.slice(0, mapping.sectionIndex)
      .reduce((sum, section) => sum + section.recordCount, mapping.localIndex);
    const record = this.getRecordByIndex(rowIndex)!;
    return record.setIdentity(spellId, rowIndex, mapping.sectionIndex, record.getParentId());
  }

  /**
   * Get table hash
   * @returns Table hash identifier
   */
  public getTableHash(): number {
    return this.getHeader().tableHash;
  }

  /**
   * Get layout hash
   * @returns Layout hash identifier
   */
  public getLayoutHash(): number {
    return this.getHeader().layoutHash;
  }

  /**
   * Get minimum ID in file
   * @returns Minimum record ID
   */
  public getMinId(): number {
    return this.getHeader().minId;
  }

  /**
   * Get maximum ID in file
   * @returns Maximum record ID
   */
  public getMaxId(): number {
    return this.getHeader().maxId;
  }

  /**
   * Load column metadata (TrinityCore format)
   * @param source File source
   * @param size Size of metadata block
   */
  /**
   * Load the field_structure block (fieldCount * 4 bytes).
   *
   * This block precedes field_storage_info in the file. It carries the
   * uncompressed field layout (unused bits + byte offset) and must be consumed
   * even though compressed fields are described by field_storage_info instead.
   */
  private loadFieldStructure(source: IDB2FileSource): void {
    const fieldCount = this.header!.fieldCount;
    const size = fieldCount * 4;
    if (size === 0) {
      this.fieldEntries = [];
      return;
    }

    const buffer = Buffer.alloc(size);
    if (!source.read(buffer, size)) {
      throw new Error('Failed to read field structure block');
    }

    this.fieldEntries = [];
    for (let i = 0; i < fieldCount; i++) {
      this.fieldEntries.push({
        unusedBits: buffer.readInt16LE(i * 4),
        offset: buffer.readUInt16LE(i * 4 + 2),
      });
    }
  }

  /**
   * Load the field_storage_info block.
   *
   * Each entry is 24 bytes, NOT 4:
   *   uint16 bitOffset, uint16 bitSize, uint32 additionalDataSize,
   *   uint32 compressionType, uint32 compressionData[3]
   *
   * This describes how each field is actually stored (plain, bit-packed,
   * pallet-indexed or common-value), which is what makes compressed tables
   * readable at all.
   */
  private loadColumnMeta(source: IDB2FileSource, size: number): void {
    const metaBuffer = Buffer.alloc(size);
    if (!source.read(metaBuffer, size)) {
      throw new Error('Failed to read field storage info');
    }

    this.columnMeta = [];
    const fieldCount = this.header!.fieldCount;
    const ENTRY_SIZE = 24;

    for (let i = 0; i < fieldCount && (i + 1) * ENTRY_SIZE <= size; i++) {
      const o = i * ENTRY_SIZE;
      const compressionType = metaBuffer.readUInt32LE(o + 8) as DB2ColumnCompression;
      const c1 = metaBuffer.readUInt32LE(o + 12);
      const c2 = metaBuffer.readUInt32LE(o + 16);
      const c3 = metaBuffer.readUInt32LE(o + 20);

      const meta: DB2ColumnMeta = {
        bitOffset: metaBuffer.readUInt16LE(o),
        bitSize: metaBuffer.readUInt16LE(o + 2),
        additionalDataSize: metaBuffer.readUInt32LE(o + 4),
        compressionType,
        compressionData: {},
      };

      switch (compressionType) {
        case DB2ColumnCompression.Immediate:
        case DB2ColumnCompression.SignedImmediate:
          meta.compressionData.immediate = { bitOffset: c1, bitWidth: c2, signed: c3 !== 0 };
          break;
        case DB2ColumnCompression.CommonData:
          meta.compressionData.commonData = { value: c1 };
          break;
        case DB2ColumnCompression.Pallet:
        case DB2ColumnCompression.PalletArray:
          meta.compressionData.pallet = { bitOffset: c1, bitWidth: c2, arraySize: c3 };
          break;
        default:
          break;
      }

      this.columnMeta.push(meta);
    }
  }

  /**
   * Load the pallet_data block into per-field value tables.
   *
   * Fields compressed as Pallet/PalletArray store a small index in the record;
   * the real value lives here. Each field consumes additionalDataSize bytes of
   * uint32 values, in field order.
   */
  private loadPalletData(source: IDB2FileSource): void {
    this.palletValues = [];
    const size = this.header!.palletDataSize;
    if (size === 0) {
      return;
    }

    const buffer = Buffer.alloc(size);
    if (!source.read(buffer, size)) {
      throw new Error('Failed to read pallet data');
    }

    let offset = 0;
    for (let field = 0; field < this.columnMeta.length; field++) {
      const meta = this.columnMeta[field];
      const values: number[] = [];
      if (
        (meta.compressionType === DB2ColumnCompression.Pallet ||
          meta.compressionType === DB2ColumnCompression.PalletArray) &&
        meta.additionalDataSize > 0
      ) {
        const end = offset + meta.additionalDataSize;
        for (let p = offset; p + 4 <= end && p + 4 <= size; p += 4) {
          values.push(buffer.readUInt32LE(p));
        }
        offset = end;
      }
      this.palletValues.push(values);
    }
  }

  /**
   * Load the common_data block into per-field id->value maps.
   *
   * Fields compressed as CommonData store nothing in the record; values are
   * held here keyed by record id, with a default in the column metadata for
   * ids that are absent. Each field consumes additionalDataSize bytes of
   * (uint32 id, uint32 value) pairs.
   */
  private loadCommonData(source: IDB2FileSource): void {
    this.commonValues = [];
    const size = this.header!.commonDataSize;
    if (size === 0) {
      return;
    }

    const buffer = Buffer.alloc(size);
    if (!source.read(buffer, size)) {
      throw new Error('Failed to read common data');
    }

    let offset = 0;
    for (let field = 0; field < this.columnMeta.length; field++) {
      const meta = this.columnMeta[field];
      const map = new Map<number, number>();
      if (meta.compressionType === DB2ColumnCompression.CommonData && meta.additionalDataSize > 0) {
        const end = offset + meta.additionalDataSize;
        for (let p = offset; p + 8 <= end && p + 8 <= size; p += 8) {
          map.set(buffer.readUInt32LE(p), buffer.readUInt32LE(p + 4));
        }
        offset = end;
      }
      this.commonValues.push(map);
    }
  }

  /**
   * Load section data
   * @param source File source
   * @param sectionIndex Section to load
   */
  private loadSectionData(source: IDB2FileSource, sectionIndex: number): void {
    const section = this.sections[sectionIndex];
    const header = this.header!;

    // Seek to section data
    if (!source.setPosition(section.fileOffset)) {
      throw new Error(`Failed to seek to section ${sectionIndex}`);
    }

    // CRITICAL FIX: Allocate COMBINED buffer like TrinityCore
    // Trinity: _data = std::make_unique<uint8[]>(RecordSize * RecordCount + StringTableSize + 8);
    //          _stringTable = &_data[RecordSize * RecordCount];
    //
    // This ensures formulas like "record + fieldOffset + stringOffset" work correctly
    // because the string table is at offset (RecordSize * RecordCount) in the combined buffer
    const recordDataSize = section.recordCount * header.recordSize;
    const combinedSize = recordDataSize + section.stringTableSize;
    const combinedBuffer = Buffer.alloc(combinedSize);

    // Read record data into first part of combined buffer
    if (!source.read(combinedBuffer.subarray(0, recordDataSize), recordDataSize)) {
      throw new Error(`Failed to read section ${sectionIndex} data`);
    }

    // Read string table into second part of combined buffer (immediately after records)
    if (section.stringTableSize > 0) {
      if (!source.read(combinedBuffer.subarray(recordDataSize, combinedSize), section.stringTableSize)) {
        throw new Error(`Failed to read section ${sectionIndex} string table`);
      }
    }

    // Set data and stringTable to point into the combined buffer (like Trinity)
    // NOTE: this.data contains ALL records, this.stringTable points to offset (recordDataSize) in same buffer
    this.data = combinedBuffer.subarray(0, recordDataSize);
    this.stringTable = combinedBuffer.subarray(recordDataSize);
  }

  /**
   * Check if file uses sparse (catalog-based) storage
   * @returns True if any section has catalog data
   */
  private isSparseFile(): boolean {
    for (const section of this.sections) {
      if (section.catalogDataCount > 0 && section.catalogDataOffset > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Load ID list and offset map for ALL sections (WoWDev Wiki format)
   * ID list: 4 bytes per entry (just the spell ID)
   * Offset map: 6 bytes per entry (uint32 offset + uint16 size)
   * @param source File source
   */
  private loadIdListAndOffsetMap(source: IDB2FileSource): void {
    // Clear section manager
    this.sectionManager.clear();

    logger.warn(`\n📂 Loading multi-section DB2 file with ${this.sections.length} sections...`);

    // Load ALL sections (not just the first one!)
    for (let sectionIdx = 0; sectionIdx < this.sections.length; sectionIdx++) {
      const section = this.sections[sectionIdx];

      if (section.idTableSize === 0 && section.catalogDataCount === 0) {
        if (this.header!.indexField < 0 || this.header!.indexField >= this.header!.fieldCount) {
          if (section.recordCount > 0) throw new Error('DB2 section has neither an ID table nor a valid inline ID field');
          continue;
        }
        const base = this.sections.slice(0, sectionIdx).reduce((sum, s) => sum + s.recordCount, 0);
        const ids = new Map<number, number>();
        for (let i = 0; i < section.recordCount; i++) {
          const id = this.getRecordByIndex(base + i)!.getId();
          ids.set(id, i);
          this.rowIds.set(base + i, id);
        }
        this.sectionManager.addSection(sectionIdx, section.fileOffset, ids, null);
        continue;
      }

      logger.warn(`\n📊 Processing Section ${sectionIdx}:`);
      logger.warn(`   Catalog entries: ${section.catalogDataCount}`);
      logger.warn(`   ID table size: ${section.idTableSize} bytes`);
      logger.warn(`   Record count: ${section.recordCount}`);

      // CRITICAL FIX: TrinityCore reads catalog data in specific order
      // Based on DB2FileLoaderSparseImpl::LoadCatalogData() lines 1017-1045
      // Structure at catalogDataOffset:
      //   1. Array of spell IDs (uint32 × catalogDataCount) - _catalogIds
      //   2. Copy table (if copyTableCount > 0)
      //   3. Array of catalog entries (DB2CatalogEntry × catalogDataCount) - offset + size pairs

      let sectionIdList: DB2IdList | null = null;
      let sectionOffsetMap: DB2OffsetMap | null = null;

      if (section.catalogDataCount > 0 && section.catalogDataOffset > 0) {
        // SPARSE FILE: Load catalog IDs and catalog entries from catalogDataOffset
        logger.warn(`   📂 Sparse section - loading ${section.catalogDataCount} catalog entries`);

        if (!source.setPosition(section.catalogDataOffset)) {
          logger.warn(`   ❌ Failed to seek to catalog offset ${section.catalogDataOffset}`);
          continue;
        }

        // Step 1: Read catalogIds array (spell IDs) - 4 bytes per entry
        const catalogIdsSize = section.catalogDataCount * 4;
        const catalogIdsBuffer = Buffer.alloc(catalogIdsSize);

        if (!source.read(catalogIdsBuffer, catalogIdsSize)) {
          logger.warn(`   ❌ Failed to read ${catalogIdsSize} bytes for catalog IDs`);
          continue;
        }

        // Parse catalog IDs into ID list
        sectionIdList = new DB2IdList();
        sectionIdList.loadFromBuffer(catalogIdsBuffer, this.header!.minId, this.header!.maxId);
        logger.warn(`   ✅ Loaded ${catalogIdsSize / 4} catalog spell IDs`);

        // Step 2: Skip copy table if present (not needed for now)
        if (section.copyTableCount > 0) {
          const copyTableSize = section.copyTableCount * 8; // 8 bytes per entry
          source.skip(copyTableSize);
          logger.warn(`   ⏭️  Skipped ${copyTableSize} bytes of copy table data`);
        }

        // Step 3: Read catalog entries array (offset + size pairs) - 6 bytes per entry
        const catalogEntriesSize = section.catalogDataCount * 6;
        const catalogEntriesBuffer = Buffer.alloc(catalogEntriesSize);

        if (!source.read(catalogEntriesBuffer, catalogEntriesSize)) {
          logger.warn(`   ❌ Failed to read ${catalogEntriesSize} bytes for catalog entries`);
          continue;
        }

        // Parse catalog entries into offset map
        sectionOffsetMap = new DB2OffsetMap();
        sectionOffsetMap.loadFromBuffer(catalogEntriesBuffer, section.catalogDataCount);
        logger.warn(`   ✅ Loaded ${section.catalogDataCount} catalog entries (offset+size pairs)`);

      } else if (section.idTableSize > 0) {
        // DENSE FILE: Load ID list from after records + string table
        const idListOffset = section.fileOffset +
                            section.recordCount * this.header!.recordSize +
                            section.stringTableSize;

        logger.warn(`   📁 Dense section - loading ${section.idTableSize} bytes of ID list`);

        if (!source.setPosition(idListOffset)) {
          logger.warn(`   ❌ Failed to seek to ID list offset ${idListOffset}`);
          continue;
        }

        const idListBuffer = Buffer.alloc(section.idTableSize);
        if (!source.read(idListBuffer, section.idTableSize)) {
          logger.warn(`   ❌ Failed to read ${section.idTableSize} bytes for ID list`);
          continue;
        }

        sectionIdList = new DB2IdList();
        sectionIdList.loadFromBuffer(idListBuffer, this.header!.minId, this.header!.maxId);
        logger.warn(`   ✅ Loaded ${section.idTableSize / 4} IDs from dense ID list`);

        // Dense files don't have offset map - records are contiguous
        sectionOffsetMap = null;
      }

      // Add section to manager (convert DB2IdList and DB2OffsetMap to Maps for section manager)
      if (sectionIdList) {
        const base = this.sections.slice(0, sectionIdx).reduce((sum, s) => sum + s.recordCount, 0);
        for (const [id, localIndex] of sectionIdList.toMap()) this.rowIds.set(base + localIndex, id);
        this.sectionManager.addSection(
          sectionIdx,
          section.fileOffset,
          sectionIdList.toMap(),
          sectionOffsetMap ? sectionOffsetMap.toMap(sectionIdList) : null
        );
        logger.warn(`   ✅ Section ${sectionIdx} loaded successfully`);
      } else {
        logger.warn(`   ⚠️  Section ${sectionIdx} has no ID list - skipping`);
      }
    }

    // Print diagnostics
    logger.warn(this.sectionManager.getDiagnostics());
  }

  /**
   * Load copy table for record aliasing
   * @param source File source
   */
  private loadCopyTable(source: IDB2FileSource): void {
    for (const section of this.sections) {
      if (section.copyTableCount === 0) {
        continue;
      }

      // Calculate copy table offset (after ID table)
      const idTableSize = section.idTableSize || 0;
      const copyTableOffset = section.catalogDataCount > 0
        ? section.catalogDataOffset + section.idTableSize
        : section.fileOffset +
                             section.recordCount * this.header!.recordSize +
                             section.stringTableSize +
                             idTableSize;

      if (!source.setPosition(copyTableOffset)) {
        continue;
      }

      // Read copy table
      const copyTableSize = section.copyTableCount * 8; // Each entry is 8 bytes (2x uint32)
      const copyTableBuffer = Buffer.alloc(copyTableSize);
      if (!source.read(copyTableBuffer, copyTableSize)) {
        continue;
      }

      // Parse copy table
      if (!this.copyTable) {
        this.copyTable = new DB2CopyTable();
      }
      this.copyTable.loadFromBuffer(copyTableBuffer, section.copyTableCount);
    }
  }

  /**
   * Load parent lookup table for foreign key relationships
   * @param source File source
   */
  private loadParentLookupTable(source: IDB2FileSource): void {
    let base = 0;
    for (const section of this.sections) {
      const sectionBase = base;
      base += section.recordCount;
      if (section.parentLookupDataSize === 0) {
        continue;
      }

      // Calculate parent lookup offset (implementation depends on file structure)
      // This is a simplified approach - actual offset calculation may vary
      const parentLookupOffset = section.catalogDataCount > 0
        ? section.catalogDataOffset + section.idTableSize + section.copyTableCount * 8 + section.catalogDataCount * 6
        : section.fileOffset +
                                section.recordCount * this.header!.recordSize +
                                section.stringTableSize +
                                (section.idTableSize || 0) +
                                (section.copyTableCount * 8 || 0);

      if (!source.setPosition(parentLookupOffset)) {
        continue;
      }

      // Read parent lookup table
      const parentLookupBuffer = Buffer.alloc(section.parentLookupDataSize);
      if (!source.read(parentLookupBuffer, section.parentLookupDataSize)) {
        continue;
      }

      // Parse parent lookup table.
      //
      // The WDC relationship block is NOT a bare array of pairs: it opens with
      // a 12-byte header (numEntries, minId, maxId) followed by the
      // (foreignId, recordIndex) pairs. Treating the whole block as pairs both
      // misreads the data and overruns the buffer, because
      // parentLookupDataSize is 12 + 8n and size/8 is fractional - the loop
      // then runs two iterations too many and reads 4 bytes past the end.
      if (section.parentLookupDataSize < PARENT_LOOKUP_HEADER_SIZE) {
        continue;
      }

      if (!this.parentLookupTable) {
        this.parentLookupTable = new DB2ParentLookupTable();
      }

      const declaredEntries = parentLookupBuffer.readUInt32LE(0);
      const availableEntries = Math.floor(
        (section.parentLookupDataSize - PARENT_LOOKUP_HEADER_SIZE) / PARENT_LOOKUP_ENTRY_SIZE
      );
      // Trust whichever is smaller: a corrupt count must not read out of bounds.
      const entryCount = Math.min(declaredEntries, availableEntries);

      for (let i = 0; i < entryCount; i++) {
        const offset = PARENT_LOOKUP_HEADER_SIZE + i * PARENT_LOOKUP_ENTRY_SIZE;
        const localIndex = parentLookupBuffer.readUInt32LE(offset + 4);
        if (localIndex >= section.recordCount) throw new Error('Relationship row index out of section bounds');
        this.parentLookupTable.add(parentLookupBuffer.readUInt32LE(offset), sectionBase + localIndex);
      }
    }
  }

  /**
   * Get section manager (contains all sections, ID lists, and offset maps)
   * @returns Section manager instance
   */
  public getSectionManager(): DB2SectionManager {
    return this.sectionManager;
  }

  /**
   * Get copy table (if loaded)
   * @returns Copy table or null
   */
  public getCopyTable(): DB2CopyTable | null {
    return this.copyTable;
  }

  /**
   * Get parent lookup table (if loaded)
   * @returns Parent lookup table or null
   */
  public getParentLookupTable(): DB2ParentLookupTable | null {
    return this.parentLookupTable;
  }

  /**
   * Check if file is using sparse format
   * @returns True if any section has catalog data
   */
  public isSparse(): boolean {
    return this.isSparseFile();
  }
}
