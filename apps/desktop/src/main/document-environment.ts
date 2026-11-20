/** Parser/guard processes receive no inherited keys, Node injection or native-binding overrides. */
export function documentEnvironment(): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? "C:\\Windows",
    DISABLE_SYSTEM_FONTS_LOAD: "1",
  };
}
