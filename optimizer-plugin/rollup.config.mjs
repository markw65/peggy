import commonjs    from "@rollup/plugin-commonjs";

export default {
  input: "plugin.js",
  output: {
    file: "build/index.js",
    format: "cjs",
  },
  external: [
    "source-map-generator",
    /node_modules/,
  ],
  plugins : [
    commonjs(),
  ],
};
