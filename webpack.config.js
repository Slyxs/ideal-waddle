const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
    entry: path.join(__dirname, 'src/index.js'),
    output: {
        path: path.join(__dirname, 'dist/'),
        filename: `index.js`,
    },
    module: {
        rules: [
            {
                // Bundle the legacy Live2D/PIXI runtime libraries as raw source
                // strings. They are injected into the page as global-scope
                // <script> blobs at runtime (see src/live2d.js), so they must
                // not be transpiled or wrapped in a module closure.
                test: /\.js$/,
                include: path.join(__dirname, 'src', 'lib'),
                type: 'asset/source',
            },
            {
                test: /\.js/,
                exclude: [/node_modules/, path.join(__dirname, 'src', 'lib')],
                options: {
                    cacheDirectory: true,
                    presets: [
                        '@babel/preset-env',
                        ['@babel/preset-react', { runtime: 'automatic' }],
                    ],
                },
                loader: 'babel-loader',
            },
        ],
    },
    optimization: {
        minimize: true,
        minimizer: [new TerserPlugin({
            extractComments: false,
        })],
    },
};
