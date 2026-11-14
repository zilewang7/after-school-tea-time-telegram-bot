/**
 * The API version of every non-Vertex Gemini client (vertexai: false).
 *
 * @google/genai 3 moved those clients from /v1beta to /v1 by default. Every
 * non-Vertex lane (the GEMINI_API_URL relay, the large-media key, the image
 * endpoint, OpenCode Go) was built and measured on /v1beta, and the OpenCode Go
 * rewrite (opencode-go-fetch.ts) only recognizes that path, so the version is
 * pinned instead of following the SDK default. A constructor option also wins
 * over GOOGLE_GENAI_API_VERSION, which 3.x reads from the env. Vertex clients
 * are left alone: their default (v1beta1) did not change.
 */
export const GEMINI_DEVELOPER_API_VERSION = 'v1beta';
