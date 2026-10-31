/*
 * Where image files are kept. Three interchangeable stores:
 *
 * - "local" (the default): a folder on this server, backend/uploads unless
 *   MEDIA_DIR says otherwise. Fine on a laptop or a server with a lasting disk.
 * - "db": a table in the MySQL database (media_files). Use this on free hosts
 *   whose disk is wiped on every restart (a Hugging Face Space) when no bucket
 *   is available. Images are small WebP files, so this suits a project of
 *   this size; the database's own backups then include them.
 * - "s3": any S3-compatible bucket, such as Cloudflare R2 or Amazon S3, for
 *   larger deployments. Set MEDIA_DRIVER=s3 and the S3_* settings in .env.
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

const SAFE_NAME = /^[a-f0-9]{32}-\d{2,4}\.webp$/;

function dbStore() {
  // Loaded when first used, so the local store never touches the database here
  const pool = require('../config/db');
  const { Readable } = require('stream');
  const check = (name) => { if (!SAFE_NAME.test(name)) throw new Error('Bad file name'); return name; };
  return {
    name: 'db',
    async put(name, buffer) {
      await pool.execute(
        'INSERT INTO media_files (name, data) VALUES (:name, :data) ON DUPLICATE KEY UPDATE data = VALUES(data)',
        { name: check(name), data: buffer }
      );
    },
    async get(name) {
      const [[row]] = await pool.execute('SELECT data FROM media_files WHERE name = :name', { name: check(name) });
      return row ? Readable.from([row.data]) : null;
    },
    async remove(name) {
      await pool.execute('DELETE FROM media_files WHERE name = :name', { name: check(name) });
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
  if (!store) store = DRIVER === 's3' ? s3Store() : DRIVER === 'db' ? dbStore() : localStore();
  return store;
}

module.exports = { storage };
