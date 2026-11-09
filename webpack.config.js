const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");

// No Babel and no loaders: `src/` is modern ES modules that node runs as they are, every
// browser that plays this does too, and nothing imports CSS or images -- the page loads
// its sprites by URL from game/. webpack is here for the one bundle `file://` can load.
module.exports = {
    mode: "production",
    // Nothing minified, as under webpack 3. webpack 5 minifies HTML assets in production
    // too, and that drops the Knockout markup's `<!-- ko -->` comments.
    optimization: { minimize: false },
    // One unsplit bundle on purpose (file:// loads no chunks), so the size hint is noise.
    performance: { hints: false },
    entry: path.join(__dirname, "src/interaction/viewmodels.js"),
    output: {
        path: path.resolve(__dirname, "game"),
        filename: "jump-n-bump.js",
    },
    plugins: [
        // The build this bundle is, stamped in at build time. A lockstep room cannot be
        // played by two different builds of the simulation, and a tab left open across a
        // rebuild goes on running the old one: nothing re-fetches a page nobody reloaded,
        // so the relay is told which build each client is and refuses the mismatch.
        new webpack.DefinePlugin({
            JNB_BUILD: JSON.stringify(String(Date.now())),
        }),
        new HtmlWebpackPlugin({
            template: path.join(__dirname, "src/jnb.html"),
            // As webpack 3's plugin did it: a plain script at the end of <body>.
            inject: "body",
            scriptLoading: "blocking",
            minify: false,
        }),
    ],
};
