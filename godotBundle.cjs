const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function createGodotBundle(bundlePath, artifacts) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(bundlePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const artifact of artifacts) {
      const artifactPath = typeof artifact === 'string' ? artifact : artifact.path;
      const artifactName = typeof artifact === 'string' ? path.basename(artifact) : artifact.name;
      archive.file(artifactPath, { name: artifactName || path.basename(artifactPath) });
    }
    archive.finalize();
  });
}

module.exports = {
  createGodotBundle,
};
