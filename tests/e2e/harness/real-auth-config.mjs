export const authEnvironment = {
  GOTRUE_DB_DRIVER: 'postgres',
  GOTRUE_DB_DATABASE_URL:
    'postgres://lending@127.0.0.1:5433/lending_e2e?sslmode=disable&search_path=auth',
  GOTRUE_DB_NAMESPACE: 'auth',
  GOTRUE_JWT_SECRET: 'harness-only-jwt-secret-not-a-real-key-32+',
  GOTRUE_SITE_URL: 'http://127.0.0.1:3000',
  API_EXTERNAL_URL: 'http://127.0.0.1:9999',
  GOTRUE_API_HOST: '127.0.0.1',
  GOTRUE_API_PORT: '9999',
  GOTRUE_JWT_EXP: '60',
  GOTRUE_JWT_AUD: 'authenticated',
  GOTRUE_JWT_ADMIN_ROLES: 'service_role',
  GOTRUE_DISABLE_SIGNUP: 'true',
  GOTRUE_MAILER_AUTOCONFIRM: 'true',
  GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true',
  GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: '10',
};
