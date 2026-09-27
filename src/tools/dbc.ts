/**
 * DBC/DB2 file reading tool
 * Week 7: Enhanced with DB2CachedFileLoader integration
 */

import * as fs from "fs";
import * as path from "path";
import { DB2CachedLoaderFactory } from "../parsers/db2/DB2CachedFileLoader";
import { SchemaFactory } from "../parsers/schemas/SchemaFactory";
import { SpellNameSchema } from "../parsers/schemas/SpellNameSchema";
import { openClientTable } from "./client-table";
import { SummonPropertiesSchema } from "../parsers/schemas/SummonPropertiesSchema";
import { SpellEffectSchema } from "../parsers/schemas/SpellEffectSchema";
import { resolveDataPath } from "../version/BuildManifest";

/**
 * Resolve the directory holding a DBC or DB2 file for the active build.
 * Must be a function, not a module constant: the manifest loads after import.
 */
function basePathFor(fileName: string): string {
  return fileName.toLowerCase().endsWith(".dbc") ? resolveDataPath("dbc") : resolveDataPath("db2");
}

/**
 * Query result for DBC/DB2 records
 */
export interface DBCQueryResult {
  file: string;
  recordId?: number;
  recordNumber?: number;
  rowIndex?: number;
  sectionId?: number;
  parentId?: number | null;
  success: boolean;
  data?: any;
  rawData?: any;
  cacheStats?: any;
  error?: string;
  note?: string;
  filePath?: string;
}

/**
 * Query DBC/DB2 file for a specific record
 * @param dbcFile File name (e.g., "Spell.db2", "Item.db2")
 * @param recordId Actual DB2 record identity, never a row ordinal
 */
export async function queryDBC(dbcFile: string, recordId?: number, rowIndex?: number): Promise<DBCQueryResult> {
  try {
    if ((recordId === undefined) === (rowIndex === undefined)) throw new Error('Provide exactly one of recordId or rowIndex');
    const value = recordId ?? rowIndex!;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('recordId/rowIndex must be a nonnegative integer');
    const loader = openClientTable(dbcFile);
    const record = recordId !== undefined ? loader.getRecord(recordId) : loader.getRecordByIndex(rowIndex!);
    if (!record) throw new Error(`Row index ${rowIndex} out of range`);
    const name = dbcFile.toLowerCase();
    let data: unknown;
    if (name === 'summonproperties.db2') {
      if (loader.getLayoutHash() !== 0xa4ca5ecf) throw new Error('SummonProperties layout mismatch');
      data = SummonPropertiesSchema.parse(record);
    } else if (name === 'spelleffect.db2') {
      if (loader.getLayoutHash() !== 0x5362e3d4) throw new Error('SpellEffect layout mismatch');
      data = SpellEffectSchema.parse(record);
    } else if (name === 'spellname.db2') {
      if (loader.getLayoutHash() !== 0x782ee721) throw new Error('SpellName layout mismatch');
      data = SpellNameSchema.parse(record);
    } else data = SchemaFactory.parseByFileName(dbcFile, record);
    return { file: dbcFile, success: true, ...record.getIdentity(), data,
      rawData: { ...record.getIdentity(), fields: extractRawFields(record) } };
  } catch (error) {
    return { file: dbcFile, recordId, rowIndex, success: false,
      error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Query all records from a DBC/DB2 file
 * @param dbcFile File name
 * @param limit Maximum records to return (default: 100)
 * @returns Array of query results
 */
export async function queryAllDBC(
  dbcFile: string,
  limit: number = 100
): Promise<DBCQueryResult> {
  try {
    const filePath = path.join(basePathFor(dbcFile), dbcFile);

    if (!fs.existsSync(filePath)) {
      return {
        file: dbcFile,
        success: false,
        error: `DBC/DB2 file not found: ${filePath}`,
        filePath,
      };
    }

    const loader = DB2CachedLoaderFactory.getLoader(dbcFile);

    try {
      if (loader.getRecordCount() === 0) {
        loader.loadFromFile(filePath);
      }
    } catch (loadError) {
      loader.loadFromFile(filePath);
    }

    const recordCount = loader.getRecordCount();
    const actualLimit = Math.min(limit, recordCount);

    // Get records with schema parsing if available
    let records: any[] = [];
    if (SchemaFactory.hasSchema(dbcFile)) {
      const typedRecords = Array.from({ length: actualLimit }, (_, i) => loader.getTypedRecordByIndex(i));
      records = typedRecords.filter((r) => r !== null);
    } else {
      const rawRecords = Array.from({ length: actualLimit }, (_, i) => loader.getRecordByIndex(i)!);
      records = rawRecords.map((r, i) => ({
        recordNumber: i,
        fields: extractRawFields(r),
      }));
    }

    const cacheStats = loader.getCacheStats();

    return {
      file: dbcFile,
      success: true,
      data: {
        totalRecords: recordCount,
        returnedRecords: records.length,
        limit: actualLimit,
        records,
      },
      cacheStats: {
        rawCacheEntries: cacheStats.raw.entryCount,
        parsedCacheEntries: cacheStats.parsed.entryCount,
        totalHits: cacheStats.totalHits,
        totalMisses: cacheStats.totalMisses,
        hitRate: cacheStats.raw.hitRate.toFixed(2) + "%",
        loadTime: cacheStats.loadTime + "ms",
      },
      filePath,
    };
  } catch (error) {
    return {
      file: dbcFile,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get cache statistics for a loaded file
 * @param dbcFile File name
 * @returns Cache statistics
 */
export async function getCacheStats(dbcFile: string): Promise<DBCQueryResult> {
  try {
    const loader = DB2CachedLoaderFactory.getLoader(dbcFile);
    const stats = loader.getCacheStats();
    const memory = loader.getCacheMemoryUsage();
    const efficiency = loader.getCacheEfficiency();

    return {
      file: dbcFile,
      success: true,
      data: {
        cacheStats: {
          rawCache: {
            entries: stats.raw.entryCount,
            hits: stats.raw.hits,
            misses: stats.raw.misses,
            evictions: stats.raw.evictions,
            hitRate: stats.raw.hitRate.toFixed(2) + "%",
            memoryMB: memory.rawMB.toFixed(2),
          },
          parsedCache: {
            entries: stats.parsed.entryCount,
            hits: stats.parsed.hits,
            misses: stats.parsed.misses,
            evictions: stats.parsed.evictions,
            hitRate: stats.parsed.hitRate.toFixed(2) + "%",
            memoryMB: memory.parsedMB.toFixed(2),
          },
          overall: {
            totalHits: stats.totalHits,
            totalMisses: stats.totalMisses,
            totalMemoryMB: memory.totalMB.toFixed(2),
            overallHitRate: efficiency.hitRate.toFixed(2) + "%",
            memoryUsagePercent: efficiency.memoryUsagePercent.toFixed(2) + "%",
            loadTime: stats.loadTime + "ms",
          },
        },
      },
    };
  } catch (error) {
    return {
      file: dbcFile,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get global cache statistics across all loaded files
 * @returns Global cache statistics
 */
export async function getGlobalCacheStats(): Promise<any> {
  try {
    const globalStats = DB2CachedLoaderFactory.getGlobalStats();

    const fileStats: any[] = [];
    for (const [fileName, stats] of globalStats.files.entries()) {
      fileStats.push({
        file: fileName,
        loadTime: stats.loadTime + "ms",
        rawEntries: stats.raw.entryCount,
        parsedEntries: stats.parsed.entryCount,
        totalHits: stats.totalHits,
        totalMisses: stats.totalMisses,
        hitRate:
          stats.totalHits + stats.totalMisses > 0
            ? ((stats.totalHits / (stats.totalHits + stats.totalMisses)) * 100).toFixed(2) + "%"
            : "0.00%",
      });
    }

    return {
      success: true,
      data: {
        totalFiles: globalStats.totalFiles,
        totalMemoryMB: globalStats.totalMemoryMB.toFixed(2),
        totalHits: globalStats.totalHits,
        totalMisses: globalStats.totalMisses,
        overallHitRate:
          globalStats.totalHits + globalStats.totalMisses > 0
            ? (
                (globalStats.totalHits / (globalStats.totalHits + globalStats.totalMisses)) *
                100
              ).toFixed(2) + "%"
            : "0.00%",
        files: fileStats,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Extract raw field values from a DB2Record
 * @param record DB2Record to extract from
 * @returns Object with field indices and values
 */
function extractRawFields(record: any): Record<string, any> {
  const fields: Record<string, any> = {};

  try {
    // Try to extract first 10 fields as uint32
    for (let i = 0; i < 10; i++) {
      try {
        fields[`field_${i}`] = record.getUInt32(i);
      } catch (e) {
        // Field doesn't exist or wrong type
        break;
      }
    }
  } catch (error) {
    // Could not extract fields
  }

  return fields;
}
