const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function createGodotBundle(bundlePath, artifactPaths) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(bundlePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const artifactPath of artifactPaths) {
      archive.file(artifactPath, { name: path.basename(artifactPath) });
    }
    archive.finalize();
  });
}

module.exports = {
  createGodotBundle,
};
