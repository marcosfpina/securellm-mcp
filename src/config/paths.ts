export const PATH_DEFAULTS: Record<string, Record<string, string>> = {
  development: {
    "@data": "./data",
    "@logs": "./logs",
    "@config": "./config",
    "@knowledge": "./data/knowledge.db"
  },
  production: {
    "@data": "/var/lib/securellm/data",
    "@logs": "/var/log/securellm",
    "@config": "/etc/securellm",
    "@knowledge": "/var/lib/mcp-knowledge/knowledge.db"
  },
  staging: {
    "@data": "/var/lib/securellm-staging/data",
    "@logs": "/var/log/securellm-staging",
    "@config": "/etc/securellm-staging",
    "@knowledge": "/var/lib/mcp-knowledge-staging/knowledge.db"
  }
};