// Defining install prevents npm from implicitly running node-gyp for binding.gyp.
// Native CASC is opt-in; JavaScript DB2/database tools have no native dependency.
console.log('Native CASC is optional. To enable it, fetch its sources and run npm run build:native.');
