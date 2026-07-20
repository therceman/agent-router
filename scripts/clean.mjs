import { rm } from 'node:fs/promises';
for (const path of ['dist', '.test-dist']) {
  await rm(path, { recursive: true, force: true });
}
