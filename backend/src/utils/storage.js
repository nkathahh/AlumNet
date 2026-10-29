/*
 * Where image files are kept. Two interchangeable stores:
 *
 * - "local" (the default): a folder on this server, backend/uploads unless
 *   MEDIA_DIR says otherwise. Fine on a laptop or a server with a lasting disk.
 * - "s3": any S3-compatible bucket, such as Cloudflare R2 or Amazon S3. Use
 *   this on hosts whose disk is wiped on every deploy (Render's free plan),
 *   or when several copies of the server run. Set MEDIA_DRIVER=s3 and the
 *   S3_* settings in .env.
 *
 * The bucket stays private: files are always served through AlumNet, which
 * checks who may see each one (see images.controller.js).
 */
const fs = require('fs');
const path = require('path');

const DRIVER = (process.env.MEDIA_DRIVER || 'local').toLowerCase();

function localStore() {
  const dir = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, '..', '..', 'uploads'));
  // Names are made by AlumNet (hex key and size), never taken from the upload
  const full = (name) => {
    if (!/^[a-f0-9]{32}-\d{2,4}\.webp$/.test(name)) throw new Error('Bad file name');
    return path.join(dir, name.slice(0, 2), name);
  };
  return {
    name: 'local',
    async put(name, buffer) {
      const file = full(name);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, buffer);
    },
    // A readable stream, or null if the file is missing
    async get(name) {
      const file = full(name);
      try {
        await fs.promises.access(file);
      } catch {
        return null;
      }
      return fs.createReadStream(file);
    },
    async remove(name) {
      await fs.promises.unlink(full(name)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    }
  };
}

function s3Store() {
  // Loaded only when used, so the local store needs nothing extra
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('MEDIA_DRIVER=s3 needs S3_BUCKET');
  const client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    credentials: process.env.S3_ACCESS_KEY_ID
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
      : undefined
  });
  const key = (name) => `images/${name.slice(0, 2)}/${name}`;
  return {
    name: 's3',
    async put(name, buffer) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key(name), Body: buffer, ContentType: 'image/webp' }));
    },
    async get(name) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(name) }));
        return out.Body;
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async remove(name) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(name) }));
    }
  };
}

let store;
function storage() {
  if (!store) store = DRIVER === 's3' ? s3Store() : localStore();
  return store;
}

module.exports = { storage };
