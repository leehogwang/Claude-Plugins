const vscode = require("vscode");
const path = require("path");

class SvgLensProvider {
  constructor(context) {
    this.context = context;
  }

  async resolveCustomTextEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      ],
    };

    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "viewer.css"))
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "viewer.js"))
    );
    const wasmUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "svg_lens_wasm.wasm"))
    );
    const nonce = getNonce();

    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${cssUri}" />
</head>
<body>
<div id="bar">
  <button id="modBtn">Modules</button>
  <button id="fitH">Fit H</button>
  <button id="fitAll">Fit</button>
  <button id="z100">100%</button>
  <button id="zIn">+</button>
  <button id="zOut">-</button>
  <span id="zLbl" class="muted">100%</span>
  <span class="sep"></span>
  <input id="q" type="text" placeholder="Search..." />
  <button id="prev">‹</button>
  <button id="next">›</button>
  <span id="qLbl" class="muted">0/0</span>
  <span class="sep"></span>
  <button id="lodBtn" class="on">LOD</button>
  <button id="colBtn">Collapse</button>
  <button id="diagBtn" class="on">Diag</button>
  <button id="listBtn">Issues <span id="iCnt">0</span></button>
</div>
<div id="vp"><div id="stage"></div><div id="macro"></div></div>
<div id="mods" class="hide"><div id="modList"></div></div>
<div id="mm"><div id="mmBox"><div id="mmRect"></div></div></div>
<div id="side" class="hide"><div id="list"></div></div>
<div id="tip" class="hide"></div>
<script nonce="${nonce}">window.__WASM_URI__ = "${wasmUri}";</script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;

    const postSvg = () => {
      webview.postMessage({ type: "svg", text: document.getText() });
    };

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        postSvg();
      }
    });

    webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === "ready") {
        postSvg();
      }
    });

    setTimeout(postSvg, 250);
    webviewPanel.onDidDispose(() => sub.dispose());
  }
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "svgLens.viewer",
      new SvgLensProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
