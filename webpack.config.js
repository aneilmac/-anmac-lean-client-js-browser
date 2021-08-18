const path = require('path');
const webpack = require('webpack');

module.exports = [{
  name: "leanBrowser",
  entry: { 
    leanBrowser:  path.resolve(__dirname, 'src', 'index.ts')
  },
  mode: 'production',
  module: {
    rules: [
      {
        test: /webworkerscript\.ts$/,
        use: [ 
          {
            loader: 'worker-loader', 
            options: { 
              inline: 'no-fallback' 
            },
          }
        ],
      },
      {
        test: /\.tsx?$/,
        use: [ {loader: 'babel-loader'}, {loader: 'ts-loader' } ],
        exclude: /node_modules/,
      }
    ]
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    fallback: { 
      "stream": require.resolve("stream-browserify"),
      "zlib": require.resolve("browserify-zlib"),
      "fs": require.resolve("brfs"),
      "path": require.resolve("path-browserify"),
      "util": require.resolve("util/"),
      "assert": require.resolve("assert/"),
      "process": require.resolve("process/browser")
    }
  },
  output: {
    filename: 'leanBrowser.bundle.js',
    publicPath: '/lean_browser/',
    library: {
      name: 'leanBrowser',
      type: 'umd2',
    },
    path: path.resolve(__dirname, 'lib'),
  },
  plugins: [
    new webpack.ProvidePlugin({
      setImmediate: [path.resolve(__dirname, 'polyfill', 'setImmediate.js'), 'setImmediate'],
      process: 'process',
      Buffer: ['buffer', 'Buffer'],
    })
  ]
}];