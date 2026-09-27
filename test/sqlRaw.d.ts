declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

declare module "cloudflare:test" {
  export const env: Env;
}
