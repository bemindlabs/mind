/** A stylesheet imported with `with { type: "text" }` is its text: Bun puts it inside the compiled program. */
declare module "*.css" {
  const text: string;
  export default text;
}
