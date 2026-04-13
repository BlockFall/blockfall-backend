import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  // At least 32 chars for HMAC-SHA256. Generate with: openssl rand -base64 32
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Comma-separated allowed SIWE domains, e.g. "localhost,blockfall.xyz"
  SIWE_DOMAINS: z.string().default('localhost'),
  // PostgreSQL connection string, e.g. postgres://user:pass@localhost:5432/blockfall
  DATABASE_URL: z.string().min(1),
});

interface ConfigValues {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  HOST: string;
  JWT_SECRET: string;
  SIWE_DOMAINS: string;
  DATABASE_URL: string;
  siweDomains: string[];
}

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

const config: ConfigValues = {
  ...parsed.data,
  siweDomains: parsed.data.SIWE_DOMAINS.split(',').map((d) => d.trim()),
};

export type Config = ConfigValues;
export default config;
