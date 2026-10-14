// The parts of the LESS compiler the offscreen page uses.
declare module "less" {
  const less: {
    render(source: string, options?: { javascriptEnabled?: boolean }): Promise<{ css: string }>;
  };
  export default less;
}
