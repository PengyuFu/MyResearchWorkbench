/** CSS Modules: every class name is a local string. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
