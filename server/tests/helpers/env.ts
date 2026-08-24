/**
 * Environment the API modules read at import time.
 *
 * `src/auth.ts` captures JWT_SECRET when it is first imported, and ES module
 * imports are evaluated before any statement in the importing file — so a test
 * that sets the variable in its own body sets it too late, and any token it
 * signs by hand is signed with a different secret than the one the server
 * verifies with. Importing this module first is what makes the two agree.
 */
process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";

export const JWT_SECRET = process.env.JWT_SECRET;
