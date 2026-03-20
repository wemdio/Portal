// Re-export generic auth/error helpers used by all tools.
// These are tool-agnostic despite living under tgOutreach/.
export { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
