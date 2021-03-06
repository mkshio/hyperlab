#!/usr/bin/env node

const { join, dirname, extname, basename, parse } = require("path");
const {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} = require("fs");
const { createServer } = require("http");

const { startServer, loadConfiguration } = require("snowpack");
const { rollup } = require("rollup");

const { sync: mkdirp } = require("mkdirp");
const httpProxy = require("http-proxy");
const htmlMinifier = require("html-minifier");
// const { typescript: svelteTypescript } = require("svelte-preprocess");
const { mdsvex } = require("mdsvex");

const svelte = require("rollup-plugin-svelte");
const { terser } = require("rollup-plugin-terser");
const { nodeResolve } = require("@rollup/plugin-node-resolve");
const commonjs = require("@rollup/plugin-commonjs");
const replace = require("@rollup/plugin-replace");
const postcss = require("rollup-plugin-postcss");
const copy = require("rollup-plugin-copy");
const svelteRollupPlugin = require("rollup-plugin-svelte");
const virtual = require("@rollup/plugin-virtual");

// consts
const assetsDirName = "assets";
const routesDirName = "routes";
const exportDirName = "export";
const htmlPath = "index.html";
const rollupVirtualFilePrefix = "\x00virtual:";
const globalAssetsPath = "global";
const appLayoutModulePath = "/_app.svelte";
const routePath = "/_snowpack/pkg/tiny-robots/runtime/Route.svelte.js";
const ssrAppSnowpackPath = "/_snowpack/pkg/tiny-robots/runtime/app.js";
const routeModulePath = "tiny-robots/runtime/Route.svelte";
const appModulePath = "tiny-robots/runtime/app";
const ssrRouteModulePath = "/node_modules/tiny-robots/runtime/Route.svelte.js";
const isSPA = true;
const devServerPort = 8081;

const defaultHtmlLayout = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>app built by tiny robots</title>
    <meta
      name="viewport"
      content="width=device-width,initial-scale=1"
    />
  </head>
  <body></body>
</html>
`;

const indexTemplate = /* html */ `<div style="width: 640px; margin: 0 auto;">
  <h1 style="text-align: center;">tiny robots app 🤖</h1>
</div>
`;

const nodeResolveOptions = {
  dedupe: ["svelte"],
};
const sveltePluginOptions = {
  preprocess: mdsvex(),
  compilerOptions: {
    hydratable: true,
  },
};
const htmlMinifyOptions = {
  collapseWhitespace: true,
  conservativeCollapse: true,
  minifyCSS: true,
};

const appPath = process.cwd();
const [, , command, ...restArgs] = process.argv;
const dev = restArgs.includes("--dev");
const viewSource = restArgs.includes("--view-source");

const appConfig = existsSync(ap("tinyrobots.config.js"))
  ? require(ap("tinyrobots.config.js"))
  : {};

function ap(...ps) {
  return join(appPath, ...ps);
}

function apr(...ps) {
  return join(appPath, routesDirName, ...ps);
}

function last(xs) {
  return xs[xs.length - 1];
}

function read(f) {
  return readFileSync(f, "utf-8");
}

function resolveAppPaths(path) {
  const fsFilePath = apr(path);
  const isDir = existsSync(fsFilePath) && statSync(fsFilePath).isDirectory();
  let pagePathBase = path;
  let pageDirPath = dirname(fsFilePath);
  if (!path || path === "/") {
    pagePathBase = "/index";
    pageDirPath = fsFilePath;
  } else if (isDir) {
    pagePathBase = join(path, "index");
    pageDirPath = fsFilePath;
  } else if (last(path) === "/") {
    pagePathBase = path.slice(0, -1);
  }

  const files = readdirSync(pageDirPath);
  const base = basename(pagePathBase);
  const fileName = files.find((f) => f.startsWith(base));
  const ext = fileName ? extname(fileName) : null;
  const pagePath = fileName ? `${pagePathBase}${ext}` : null;

  return {
    pageId: pagePathBase.slice(1),
    pagePathBase,
    pageDirPath,
    fileName,
    pagePath,
    ext,
  };
}

class Renderer {
  async init() {
    this.proxy = httpProxy.createServer({
      target: "http://localhost:" + devServerPort,
    });

    const baseSnowpackConfig = snowpackConfig({
      proxyDest: (req, res) => this.proxy.web(req, res),
    });

    const finalSnowpackConfig = appConfig.snowpack
      ? appConfig.snowpack(baseSnowpackConfig)
      : baseSnowpackConfig;

    const config = await loadConfiguration(finalSnowpackConfig);

    // HACK: remove me once the snowpack patch lands
    const { rollup } = config.packageOptions;
    rollup.plugins = rollup.plugins
      .filter((p) => p.name !== "svelte")
      .concat(
        svelteRollupPlugin({
          include: /\.svelte$/,
          compilerOptions: {
            dev: process.env.NODE_ENV !== "production",
            hydratable: true,
          },
          emitCss: false,
        })
      );

    this.server = await startServer({
      config,
      lockfile: null,
    });

    this.runtime = this.server.getServerRuntime();
  }

  getUrl(path) {
    return this.server.getUrlForFile(apr(path));
  }

  async prefetchPath(path) {
    const pageUrl = this.server.getUrlForFile(apr(path));
    const { prefetch } = (await this.runtime.importModule(pageUrl)).exports;

    if (prefetch) {
      return prefetch({ static: true, params: {} });
    }
  }

  async renderPage(
    path,
    { pageId, src, code, preloads, layoutPath, appLayoutPath, dev, hot }
  ) {
    const pageUrl = this.server.getUrlForFile(apr(path));
    const { default: pageComponent, prefetch } = (
      await this.runtime.importModule(pageUrl)
    ).exports;

    let prefetchedProps;
    if (prefetch) {
      prefetchedProps = await prefetch({ static: true, params: {} });
    }
    const stringifiedProps = JSON.stringify(prefetchedProps ?? {});

    const globalFiles = getGlobalFiles();

    let script = "";
    if (preloads) {
      for (const preload of preloads) {
        script += `<link rel="modulepreload" href="${preload}">`;
      }
    }
    if (code) {
      script += `<script type="module">
${code}
start({ pageProps: ${stringifiedProps}, hydrate: true });
</script>`;
    } else if (src) {
      script += `
<link rel="modulepreload" href="${src}">
<script type="module">
import { start } from '${src}';
start({ pageProps: ${stringifiedProps}, hydrate: true });
</script>`;
    }

    for (const { code } of globalFiles.js) {
      script += `<script>${code}</script>`;
    }

    let layoutComponent;
    if (layoutPath) {
      const url = this.server.getUrlForFile(apr(layoutPath));
      layoutComponent = (await this.runtime.importModule(url)).exports.default;
    }

    let appLayoutComponent;
    if (appLayoutPath) {
      const url = this.server.getUrlForFile(apr(appLayoutPath));
      appLayoutComponent = (await this.runtime.importModule(url)).exports
        .default;
    }

    const RouteComponent = (await this.runtime.importModule(ssrRouteModulePath))
      .exports.default;

    const {
      head: pageHead,
      css: pageCss,
      html: rootHtml,
    } = RouteComponent.render({
      pageComponent,
      appLayoutComponent,
      layoutComponent,
      pageId,
      fetching: true,
      pageProps: { ...prefetchedProps },
    });

    const headCode = pageHead;

    const cssCode = [...globalFiles.css.map(({ code }) => code), pageCss.code]
      .filter((s) => s)
      .reduce(
        (h, s) =>
          h +
          `<style ${hot ? `data-style-dev ` : ""}type="text/css">${s}</style>`,
        ""
      );

    let devHotGlobalCss;
    if (hot) {
      const cssImports = globalFiles.css
        .map(({ path }) => `import "${path}.proxy.js";`)
        .join("\n");

      devHotGlobalCss = `<script type="module">
${cssImports}
document.querySelectorAll('[data-style-dev]').forEach(el => el.remove());
</script>`;
    }

    const baseHtml = existsSync(ap(htmlPath))
      ? read(ap(htmlPath))
      : defaultHtmlLayout;

    const page = baseHtml
      .replace(
        `</head>`,
        [cssCode, script, headCode, devHotGlobalCss].join("\n") + "</head>"
      )
      .replace(`<body>`, `<body>\n` + rootHtml);

    if (dev) {
      return { page, prefetchedProps };
    }

    const minifiedPage = htmlMinifier.minify(page, htmlMinifyOptions);

    return { page: minifiedPage, prefetchedProps };
  }

  async stop() {
    this.proxy.close();
    await this.server.shutdown();
  }
}

async function devServer() {
  const renderer = new Renderer();

  await renderer.init();

  createServer(async (req, res) => {
    function error404() {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("404: Not found");
    }

    const [path] = req.url.split("?");
    const segments = path.slice(1).split("/");
    const lastSegment = last(segments);

    const {
      pageId,
      pagePathBase,
      pageDirPath,
      pagePath,
      fileName,
    } = resolveAppPaths(path);

    if (fileName?.endsWith(".html")) {
      const htmlPath = apr(pagePathBase + ".html");
      res.setHeader("Content-Type", "text/html");
      res.statusCode = 200;
      res.end(read(htmlPath));
      return;
    }

    let appLayoutUrl;
    let appLayoutPath;
    const hasAppLayout = existsSync(apr(appLayoutModulePath));
    if (hasAppLayout) {
      appLayoutPath = appLayoutModulePath;
      appLayoutUrl = renderer.getUrl(appLayoutModulePath);
    }

    if (path === "/assets/manifest") {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          __dev__appLayoutUrl: appLayoutUrl,
          paths: devManifest(),
        })
      );
      return;
    }

    if (["_app", "_layout"].includes(lastSegment)) {
      error404();
      return;
    }

    if (path.startsWith("/_dev_prefetch")) {
      const pagepath = path.replace("/_dev_prefetch", "");
      const { pagePath } = resolveAppPaths(pagepath);
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      const data = await renderer.prefetchPath(pagePath);
      res.end(JSON.stringify(data));
      return;
    }

    if (["_app", "_layout"].includes(lastSegment)) {
      error404();
      return;
    }

    try {
      const pageUrl = renderer.getUrl(pagePath);
      const maybeLayoutPath = join(pageDirPath, "_layout.svelte");

      let layoutUrl;
      let layoutPath;
      const hasLayout = existsSync(maybeLayoutPath);
      if (hasLayout) {
        layoutPath = join(dirname(pagePathBase), "_layout.svelte");
        layoutUrl = renderer.getUrl(layoutPath);
      }

      let indexUrl;
      const hasIndex = existsSync(ap("index.js"));
      if (hasIndex) {
        indexUrl = "/index.js";
      }

      const code = genEntry(
        pageId,
        indexUrl,
        pageUrl,
        layoutUrl,
        appLayoutUrl,
        routePath,
        ssrAppSnowpackPath,
        isSPA,
        true
      );

      const { page } = await renderer.renderPage(pagePath, {
        appLayoutPath,
        layoutPath,
        code,
        src: undefined,
        preloads: undefined,
        dev: true,
        hot: true,
      });

      res.setHeader("Content-Type", "text/html");
      res.statusCode = 200;
      res.end(page);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.write(`500: Oops, something broke!\n\n${error.stack}`);
      res.end();
      return;
    }
  }).listen(devServerPort);
}

function genEntry(
  pageId,
  indexUrl,
  pageUrl,
  layoutUrl,
  appLayoutUrl,
  routeUrl,
  appUrl,
  isSPA,
  isDev
) {
  return `// generated by tiny robots
${indexUrl ? `import '${indexUrl}';` : ``}
import Route from "${routeUrl}";
import * as page from '${pageUrl}';
${layoutUrl ? `import Layout from '${layoutUrl}';` : `const Layout = null;`}
${
  appLayoutUrl
    ? `import AppLayout from '${appLayoutUrl}';`
    : `const AppLayout = null;`
}

const start = ({ pageProps, hydrate }) => {
  const root = new Route({
    target: document.body,
    hydrate,
    props: {
      ...routeProps(),
      pageId: "${pageId}",
      fetching: true,
      pageProps
    }
  });

  ${
    isSPA
      ? `import("${appUrl}")
    .then(m => m.start({ root, dev: ${!!isDev}, page, pageProps }));`
      : ""
  }
}

const routeProps = () => ({
  appLayoutComponent: AppLayout,
  layoutComponent: Layout,
  pageComponent: page.default,
})

export { page, start, routeProps };
`;
}

async function static({ dev } = {}) {
  const renderer = new Renderer();
  await renderer.init();

  const pages = allPages(apr("."));

  const hasAppLayout = existsSync(apr("_app.svelte"));
  const hasAppIndex = existsSync(ap("index.js"));
  const {
    entries,
    virtualEntries: baseVirtualEntries,
    fileNamesToEntries,
  } = pagesToEntries(pages, hasAppLayout, hasAppIndex);

  const viewSourceCodeCache = new Map();

  const target = join(appPath, routesDirName, "/");

  const virtualEntries = {
    ...baseVirtualEntries,
    ...appConfig.virtualEntries,
  };

  const baseRollupConfig = rollupConfig({
    fileNames: { ...entries, ...(appConfig.entries ?? {}) },
    dev,
    virtualEntries,
    onSvelteTransform: ({ id, output }) => {
      if (id.startsWith(target)) {
        const id_ = id.replace(target, "");

        viewSourceCodeCache.set(id_, output);
      }
    },
  });

  const finalRollupConfig = appConfig.rollup
    ? appConfig.rollup(baseRollupConfig)
    : baseRollupConfig;

  const build = await rollup(finalRollupConfig);

  mkdirp(ap(exportDirName));
  mkdirp(ap(exportDirName, "assets"));
  mkdirp(ap(exportDirName, "assets", "_data"));
  const bundle = await build.write({
    sourcemap: true,
    hoistTransitiveImports: false,
    compact: true,
    entryFileNames: (chunkInfo) => {
      return chunkInfo.name.replace("_virtual:", "") + ".js";
    },
    format: "es",
    dir: join(".", exportDirName, assetsDirName),
  });

  /**
   * @param o {import("rollup").OutputChunk & { facadeModuleId: string }}
   * @returns {[string, import("rollup").OutputChunk]}
   */
  const mapOutput = (o) => [
    o.facadeModuleId.replace(rollupVirtualFilePrefix, ""),
    o,
  ];

  const indexedOutput = new Map(
    bundle.output
      .filter((o) => "facadeModuleId" in o && o.facadeModuleId)
      .map(mapOutput)
  );

  const manifest = {};

  await Promise.all(
    pages.map(async function ({
      path,
      name,
      dir,
      hasLayout,
      filePath,
      pageId,
    }) {
      const { name: baseName, ext } = parse(name);
      const layoutPath = hasLayout ? join(dir, "_layout.svelte") : null;
      const output = indexedOutput.get(fileNamesToEntries[filePath]);
      const outputFilePath = join("/", assetsDirName, output.fileName);
      const dataPath = join(
        ".",
        assetsDirName,
        "_data",
        parse(output.fileName).name + ".json"
      );
      // const dataFilePath = join("/", assetsDirName, "_data", output.fileName);

      const preloadJs = (output?.imports ?? []).map((m) =>
        join("/", assetsDirName, m)
      );

      let page;
      let prefetchedProps;
      try {
        p = await renderer.renderPage(filePath, {
          pageId,
          layoutPath,
          appLayoutPath: hasAppLayout ? "_app.svelte" : null,
          src: outputFilePath,
          preloads: [...preloadJs, outputFilePath],
          code: undefined,
          dev,
          hot: false,
        });
        page = p.page;
        prefetchedProps = p.prefetchedProps;
      } catch (error) {
        console.error(`Export failed on page '${page}' with error:`, error);
        throw new Error("Export error");
      }

      mkdirp(join(".", exportDirName, dir));
      if (prefetchedProps) {
        writeFileSync(
          join(".", exportDirName, dataPath),
          JSON.stringify(prefetchedProps, null, dev ? "\t" : undefined)
        );
      }
      writeFileSync(join(".", exportDirName, dir, baseName + ".html"), page);

      manifest[path] = {
        path,
        pageId,
        js: outputFilePath,
        preloadJs,
        data: prefetchedProps ? join("/", dataPath) : undefined,
      };

      const compiled = viewSourceCodeCache.get(filePath);

      if (viewSource) {
        const entryCode = virtualEntries[filePath];
        const sources = {
          ext,
          main: readFileSync(apr(filePath), "utf-8"),
          entry: entryCode,
          compiled,
        };

        mkdirp(join(".", exportDirName, "view-source", "entries", dir));
        writeFileSync(
          join(".", exportDirName, "view-source", "entries", pageId + ".json"),
          JSON.stringify(sources)
        );
      }
    })
  );

  writeFileSync(
    ap(exportDirName, assetsDirName, "manifest.json"),
    JSON.stringify({ paths: manifest }, null, dev ? "\t" : undefined)
  );

  await build.close();
  await renderer.stop();
}

function pagesToEntries(pages, hasAppLayout, hasAppIndex) {
  const entries = {};
  const virtualEntries = {};
  const fileNamesToEntries = {};
  for (const { dir, filePath, hasLayout, pageId } of pages) {
    const code = genEntry(
      pageId,
      hasAppIndex ? "./index" : null,
      join(".", routesDirName, filePath),
      hasLayout ? join(".", routesDirName, dir, "_layout.svelte") : null,
      hasAppLayout ? join(".", routesDirName, "_app.svelte") : null,
      routeModulePath,
      appModulePath,
      isSPA,
      false
    );

    entries[filePath] = filePath;
    virtualEntries[filePath] = code;
    fileNamesToEntries[filePath] = filePath;
  }

  return {
    entries,
    virtualEntries,
    fileNamesToEntries,
  };
}

function rollupConfig({ fileNames, dev, virtualEntries, onSvelteTransform }) {
  const sveltePlugin = svelte({
    ...sveltePluginOptions,
    extensions: [".svelte", ".svx"],
    emitCss: false,
  });

  // HACK: I'm sorry
  const _transform = sveltePlugin.transform;
  sveltePlugin.transform = async function (code, id) {
    const result = await _transform.apply(this, [code, id]);

    onSvelteTransform &&
      onSvelteTransform({
        id,
        input: code,
        output: result ? result.code : null,
      });

    return result;
  };

  // const _load = sveltePlugin.load;
  // sveltePlugin.load = (id) => {
  //   const result = _load(id);
  //   return result;
  // };

  /** @type {import('rollup').RollupOptions} */
  const options = {
    input: fileNames,
    preserveSymlinks: true,
    plugins: [
      replace({
        "process.browser": true,
        "process.env": JSON.stringify({
          NODE_ENV: dev ? "development" : "production",
        }),
      }),
      virtual({
        ...virtualEntries,
        // HACK: use a plugin instead
        fs: "export default {}",
        path: "export default {}",
      }),
      sveltePlugin,
      nodeResolve({
        ...nodeResolveOptions,
        browser: true,
      }),
      commonjs(),
      postcss(),
      copy({
        targets: [
          {
            src: ap("static"),
            dest: ap("export"),
          },
          {
            src: ap("routes/**/*.html"),
            dest: ap("export"),
            flatten: false,
            transform: (html) => {
              return htmlMinifier.minify(html.toString(), htmlMinifyOptions);
            },
          },
        ],
      }),
      !dev && terser(),
    ],
  };

  return options;
}

function snowpackConfig({ proxyDest }) {
  /** @type {import('snowpack').CommandOptions['config']} */
  const config = {
    root: appPath,
    mount: {},
    exclude: [ap("export"), ap("build")],
    plugins: [
      [
        "@snowpack/plugin-svelte",
        {
          ...sveltePluginOptions,
          input: [".svelte", ".svx"],
        },
      ],
    ],
    devOptions: {
      open: "none",
      output: "stream",
    },
    buildOptions: {},
    routes: [
      {
        match: "routes",
        src: ".*",
        dest: proxyDest,
      },
    ],
    packageOptions: {
      polyfillNode: true,
      knownEntrypoints: [routeModulePath, appModulePath],
      rollup: nodeResolveOptions,
    },
  };

  return config;
}

function allPages(root, dir = "") {
  let pages = [];
  const dirents = readdirSync(join(root, dir), { withFileTypes: true });
  const hasLayout = !!dirents.find(
    (dirent) => dirent.name === "_layout.svelte"
  );
  for (const dirent of dirents) {
    const ext = extname(dirent.name);
    if (["_layout.svelte", "_app.svelte"].includes(dirent.name)) {
      continue;
    } else if (dirent.isDirectory()) {
      for (const page of allPages(root, join(dir, dirent.name))) {
        pages.push(page);
      }
    } else if ([".svelte", ".svx"].includes(ext)) {
      const baseName = parse(dirent.name).name;
      pages.push({
        pageId: join(dir, baseName),
        path: join("/", dir, baseName === "index" ? "." : baseName),
        dir,
        hasLayout,
        filePath: join(dir, dirent.name),
        name: dirent.name,
      });
    }
  }

  return pages;
}

function devManifest() {
  const pages = allPages(apr("."));

  const manifest = {};

  for (const { path, filePath, hasLayout, dir, pageId } of pages) {
    manifest[path] = {
      pageId,
      path,
      js: join("/", routesDirName, filePath + ".js"),
      __dev__layoutJs: hasLayout
        ? join("/", routesDirName, dir, "_layout.svelte.js")
        : null,
    };
  }

  return manifest;
}

function getGlobalFiles() {
  let css = [];
  let js = [];

  if (existsSync(ap(globalAssetsPath))) {
    for (const name of readdirSync(ap(globalAssetsPath))) {
      if (extname(name) === ".css") {
        css.push({
          code: read(ap(globalAssetsPath, name)),
          path: join("/", globalAssetsPath, name),
        });
      } else if (extname(name) === ".js") {
        js.push({
          code: read(ap(globalAssetsPath, name)),
          path: join("/", globalAssetsPath, name),
        });
      }
    }
  }

  return { css, js };
}

function init() {
  mkdirp(ap("static"));

  if (!existsSync(ap("global"))) {
    mkdirp(ap("global"));
    writeFileSync(
      ap("global/global.css"),
      `body {
  font-family: system-ui, sans;
}`
    );
  }

  if (!existsSync(ap("routes"))) {
    mkdirp(ap("routes"));
    writeFileSync(ap("routes/index.svelte"), indexTemplate);
  }

  if (!existsSync(ap("index.html"))) {
    writeFileSync(ap("index.html"), defaultHtmlLayout);
  }
}

async function main() {
  snowHACK();
  if (!command || command === "dev") {
    devServer();
  } else if (command === "init") {
    init();
  } else if (command === "export") {
    try {
      await static({ dev });
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  } else {
    console.error("Unrecognized command.");
  }
}

function stackTrace(x) {
  return new Error(x).stack;
}

function snowHACK() {
  const snowStack = "SnowpackLogger";

  const _log = console.log;
  console.log = (...args) => {
    const stack = stackTrace();

    if (stack?.includes(snowStack)) {
      return;
    }

    _log(...args);
  };

  const _info = console.info;
  console.info = (...args) => {
    const stack = stackTrace();

    if (stack?.includes(snowStack)) {
      return;
    }

    _info(...args);
  };

  const _warn = console.warn;
  console.warn = (...args) => {
    const stack = stackTrace();

    if (stack?.includes(snowStack)) {
      return;
    }

    _warn(...args);
  };

  const _error = console.error;
  console.error = (...args) => {
    const stack = stackTrace();

    if (stack?.includes(snowStack)) {
      return;
    }

    _error(...args);
  };
}

main();
