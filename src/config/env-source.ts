/**
 * Environment variables as a config reader takes them. Every key is optional,
 * unlike NodeJS.ProcessEnv, which declares the ones the bot cannot start
 * without as always present: a caller passes only the keys it is about.
 */
export type EnvSource = Readonly<Partial<NodeJS.ProcessEnv>>;
