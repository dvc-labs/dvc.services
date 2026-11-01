import { createRequire } from 'node:module';

const packageInfo = createRequire(import.meta.url)('../package.json') as { version: string };
export const VERSION = packageInfo.version;
export const BRAND_COLOR = 0x26bcc5;
export const REPOSITORY_URL = 'https://github.com/dvc-labs/dvc.services';
export const WEBSITE_URL = 'https://www.davevancauwenberghe.be';
export const GITHUB_URL = 'https://github.com/dvc-labs';
export const DVC_EMOJI = '<:dvc:1566457051465388194>';
