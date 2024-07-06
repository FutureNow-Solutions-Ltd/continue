/* eslint-disable @typescript-eslint/naming-convention */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { ContextMenuConfig, IDE } from "core";
import { CompletionProvider } from "core/autocomplete/completionProvider";
import { IConfigHandler } from "core/config/IConfigHandler";
import { ContinueServerClient } from "core/continueServer/stubs/client";
import { GlobalContext } from "core/util/GlobalContext";
import { getConfigJsonPath, getDevDataFilePath } from "core/util/paths";
import { Telemetry } from "core/util/posthog";
import readLastLines from "read-last-lines";
import {
  StatusBarStatus,
  getStatusBarStatus,
  getStatusBarStatusFromQuickPickItemLabel,
  quickPickStatusText,
  setupStatusBar,
} from "./autocomplete/statusBar";
import { ContinueGUIWebviewViewProvider } from "./debugPanel";
import { DiffManager } from "./diff/horizontal";
import { VerticalPerLineDiffManager } from "./diff/verticalPerLine/manager";
import { QuickEdit } from "./quickEdit/QuickEdit";
import { Battery } from "./util/battery";
import type { VsCodeWebviewProtocol } from "./webviewProtocol";

let fullScreenPanel: vscode.WebviewPanel | undefined;

function getFullScreenTab() {
  const tabs = vscode.window.tabGroups.all.flatMap((tabGroup) => tabGroup.tabs);
  return tabs.find((tab) =>
    (tab.input as any)?.viewType?.endsWith("continue.continueGUIView"),
  );
}

type TelemetryCaptureParams = Parameters<typeof Telemetry.capture>;

/**
 * Helper method to add the `isCommandEvent` to all telemetry captures
 */
function captureCommandTelemetry(
  commandName: TelemetryCaptureParams[0],
  properties: TelemetryCaptureParams[1] = {},
) {
  Telemetry.capture(commandName, { isCommandEvent: true, ...properties });
}

async function addHighlightedCodeToContext(
  edit: boolean,
  webviewProtocol: VsCodeWebviewProtocol | undefined,
) {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const selection = editor.selection;
    if (selection.isEmpty) {
      // Capture highlighted terminal text
      // const activeTerminal = vscode.window.activeTerminal;
      // if (activeTerminal) {
      //   // Copy selected text
      //   const tempCopyBuffer = await vscode.env.clipboard.readText();
      //   await vscode.commands.executeCommand(
      //     "workbench.action.terminal.copySelection",
      //   );
      //   await vscode.commands.executeCommand(
      //     "workbench.action.terminal.clearSelection",
      //   );
      //   const contents = (await vscode.env.clipboard.readText()).trim();
      //   await vscode.env.clipboard.writeText(tempCopyBuffer);

      //   // Add to context
      //   const rangeInFileWithContents = {
      //     filepath: activeTerminal.name,
      //     contents,
      //     range: {
      //       start: {
      //         line: 0,
      //         character: 0,
      //       },
      //       end: {
      //         line: contents.split("\n").length,
      //         character: 0,
      //       },
      //     },
      //   };

      //   if (contents.trim() !== "") {
      //     webviewProtocol?.request("highlightedCode", {
      //       rangeInFileWithContents,
      //     });
      //   }
      // }
      return;
    }
    // adjust starting position to include indentation
    const start = new vscode.Position(selection.start.line, 0);
    const range = new vscode.Range(start, selection.end);
    const contents = editor.document.getText(range);
    const rangeInFileWithContents = {
      filepath: editor.document.uri.fsPath,
      contents,
      range: {
        start: {
          line: selection.start.line,
          character: selection.start.character,
        },
        end: {
          line: selection.end.line,
          character: selection.end.character,
        },
      },
    };

    webviewProtocol?.request("highlightedCode", {
      rangeInFileWithContents,
    });
  }
}

async function addEntireFileToContext(
  filepath: vscode.Uri,
  edit: boolean,
  webviewProtocol: VsCodeWebviewProtocol | undefined,
) {
  // If a directory, add all files in the directory
  const stat = await vscode.workspace.fs.stat(filepath);
  if (stat.type === vscode.FileType.Directory) {
    const files = await vscode.workspace.fs.readDirectory(filepath);
    for (const [filename, type] of files) {
      if (type === vscode.FileType.File) {
        addEntireFileToContext(
          vscode.Uri.joinPath(filepath, filename),
          edit,
          webviewProtocol,
        );
      }
    }
    return;
  }

  // Get the contents of the file
  const contents = (await vscode.workspace.fs.readFile(filepath)).toString();
  const rangeInFileWithContents = {
    filepath: filepath.fsPath,
    contents: contents,
    range: {
      start: {
        line: 0,
        character: 0,
      },
      end: {
        line: contents.split(os.EOL).length - 1,
        character: 0,
      },
    },
  };

  webviewProtocol?.request("highlightedCode", {
    rangeInFileWithContents,
  });
}

// Copy everything over from extension.ts
const commandsMap: (
  ide: IDE,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  configHandler: IConfigHandler,
  diffManager: DiffManager,
  verticalDiffManager: VerticalPerLineDiffManager,
  continueServerClientPromise: Promise<ContinueServerClient>,
  battery: Battery,
) => { [command: string]: (...args: any) => any } = (
  ide,
  extensionContext,
  sidebar,
  configHandler,
  diffManager,
  verticalDiffManager,
  continueServerClientPromise,
  battery,
) => {
  /**
   * Streams an inline edit to the vertical diff manager.
   *
   * This function retrieves the configuration, determines the appropriate model title,
   * increments the FTC count, and then streams an edit to the
   * vertical diff manager.
   *
   * @param  promptName - The key for the prompt in the context menu configuration.
   * @param  fallbackPrompt - The prompt to use if the configured prompt is not available.
   * @param  [onlyOneInsertion] - Optional. If true, only one insertion will be made.
   * @param  [range] - Optional. The range to edit if provided.
   * @returns
   */
  async function streamInlineEdit(
    promptName: keyof ContextMenuConfig,
    fallbackPrompt: string,
    onlyOneInsertion?: boolean,
    range?: vscode.Range,
  ) {
    const config = await configHandler.loadConfig();

    const modelTitle =
      config.experimental?.modelRoles?.inlineEdit ??
      (await sidebar.webviewProtocol.request(
        "getDefaultModelTitle",
        undefined,
      ));

    sidebar.webviewProtocol.request("incrementFtc", undefined);

    await verticalDiffManager.streamEdit(
      config.experimental?.contextMenuPrompts?.[promptName] ?? fallbackPrompt,
      modelTitle,
      onlyOneInsertion,
      undefined,
      range,
    );
  }

  const historyUpEventEmitter = new vscode.EventEmitter<void>();
  const historyDownEventEmitter = new vscode.EventEmitter<void>();
  const quickEdit = new QuickEdit(
    verticalDiffManager,
    configHandler,
    sidebar.webviewProtocol,
    ide,
    extensionContext,
    historyUpEventEmitter.event,
    historyDownEventEmitter.event,
  );

  return {
    "continue.acceptDiff": async (newFilepath?: string | vscode.Uri) => {
      captureCommandTelemetry("acceptDiff");

      if (newFilepath instanceof vscode.Uri) {
        newFilepath = newFilepath.fsPath;
      }
      verticalDiffManager.clearForFilepath(newFilepath, true);
      await diffManager.acceptDiff(newFilepath);
    },
    "continue.rejectDiff": async (newFilepath?: string | vscode.Uri) => {
      captureCommandTelemetry("rejectDiff");

      if (newFilepath instanceof vscode.Uri) {
        newFilepath = newFilepath.fsPath;
      }
      verticalDiffManager.clearForFilepath(newFilepath, false);
      await diffManager.rejectDiff(newFilepath);
    },
    "continue.acceptVerticalDiffBlock": (filepath?: string, index?: number) => {
      captureCommandTelemetry("acceptVerticalDiffBlock");
      verticalDiffManager.acceptRejectVerticalDiffBlock(true, filepath, index);
    },
    "continue.rejectVerticalDiffBlock": (filepath?: string, index?: number) => {
      captureCommandTelemetry("rejectVerticalDiffBlock");
      verticalDiffManager.acceptRejectVerticalDiffBlock(false, filepath, index);
    },
    "continue.quickFix": async (
      message: string,
      code: string,
      edit: boolean,
    ) => {
      captureCommandTelemetry("rejectVerticalDiffBlock", {
        edit,
      });

      sidebar.webviewProtocol?.request("newSessionWithPrompt", {
        prompt: `${
          edit ? "/edit " : ""
        }${code}\n\nHow do I fix this problem in the above code?: ${message}`,
      });

      if (!edit) {
        vscode.commands.executeCommand("continue.continueGUIView.focus");
      }
    },
    "continue.defaultQuickActionDocstring": async (range: vscode.Range) => {
      captureCommandTelemetry("defaultQuickActionDocstring");

      streamInlineEdit(
        "docstring",
        "Write a docstring for this code. Do not change anything about the code itself.",
        true,
        range,
      );
    },
    "continue.defaultQuickActionExplain": async (code: string) => {
      captureCommandTelemetry("defaultQuickActionExplain");

      vscode.commands.executeCommand("continue.continueGUIView.focus");

      sidebar.webviewProtocol?.request("userInput", {
        input:
          `Explain the following code in a few sentences without ` +
          `going into detail on specific methods:\n\n ${code}`,
      });
    },
    "continue.customQuickActionSendToChat": async (
      prompt: string,
      code: string,
    ) => {
      captureCommandTelemetry("customQuickActionSendToChat");

      vscode.commands.executeCommand("continue.continueGUIView.focus");

      sidebar.webviewProtocol?.request("userInput", {
        input: `${prompt}:\n\n ${code}`,
      });
    },
    "continue.customQuickActionStreamInlineEdit": async (
      prompt: string,
      range: vscode.Range,
    ) => {
      captureCommandTelemetry("customQuickActionStreamInlineEdit");

      streamInlineEdit("docstring", prompt, false, range);
    },
    "continue.focusContinueInput": async () => {
      const fullScreenTab = getFullScreenTab();
      if (!fullScreenTab) {
        // focus sidebar
        vscode.commands.executeCommand("continue.continueGUIView.focus");
      } else {
        // focus fullscreen
        fullScreenPanel?.reveal();
      }
      sidebar.webviewProtocol?.request("focusContinueInput", undefined);
      await addHighlightedCodeToContext(false, sidebar.webviewProtocol);
    },
    "continue.focusContinueInputWithoutClear": async () => {
      if (!getFullScreenTab()) {
        vscode.commands.executeCommand("continue.continueGUIView.focus");
      }
      sidebar.webviewProtocol?.request(
        "focusContinueInputWithoutClear",
        undefined,
      );
      await addHighlightedCodeToContext(true, sidebar.webviewProtocol);
    },
    "continue.toggleAuxiliaryBar": () => {
      vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
    },
    "continue.quickEdit": (injectedPrompt?: string) => {
      captureCommandTelemetry("quickEdit");
      quickEdit.run(injectedPrompt);
    },
    "continue.writeCommentsForCode": async () => {
      captureCommandTelemetry("writeCommentsForCode");

      streamInlineEdit(
        "comment",
        "Write comments for this code. Do not change anything about the code itself.",
      );
    },
    "continue.writeDocstringForCode": async () => {
      captureCommandTelemetry("writeDocstringForCode");

      streamInlineEdit(
        "docstring",
        "Write a docstring for this code. Do not change anything about the code itself.",
        true,
      );
    },
    "continue.fixCode": async () => {
      captureCommandTelemetry("fixCode");

      streamInlineEdit(
        "fix",
        "Fix this code. If it is already 100% correct, simply rewrite the code.",
      );
    },
    "continue.optimizeCode": async () => {
      captureCommandTelemetry("optimizeCode");
      streamInlineEdit("optimize", "Optimize this code");
    },
    "continue.fixGrammar": async () => {
      captureCommandTelemetry("fixGrammar");
      streamInlineEdit(
        "fixGrammar",
        "If there are any grammar or spelling mistakes in this writing, fix them. Do not make other large changes to the writing.",
      );
    },
    "continue.viewLogs": async () => {
      captureCommandTelemetry("viewLogs");

      // Open ~/.continue/continue.log
      const logFile = path.join(os.homedir(), ".continue", "continue.log");
      // Make sure the file/directory exist
      if (!fs.existsSync(logFile)) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, "");
      }

      const uri = vscode.Uri.file(logFile);
      await vscode.window.showTextDocument(uri);
    },
    "continue.debugTerminal": async () => {
      captureCommandTelemetry("debugTerminal");

      const terminalContents = await ide.getTerminalContents();

      vscode.commands.executeCommand("continue.continueGUIView.focus");

      sidebar.webviewProtocol?.request("userInput", {
        input: `I got the following error, can you please help explain how to fix it?\n\n${terminalContents.trim()}`,
      });
    },
    "continue.hideInlineTip": () => {
      vscode.workspace
        .getConfiguration("continue")
        .update("showInlineTip", false, vscode.ConfigurationTarget.Global);
    },

    // Commands without keyboard shortcuts
    "continue.addModel": () => {
      captureCommandTelemetry("addModel");

      vscode.commands.executeCommand("continue.continueGUIView.focus");
      sidebar.webviewProtocol?.request("addModel", undefined);
    },
    "continue.openSettingsUI": () => {
      vscode.commands.executeCommand("continue.continueGUIView.focus");
      sidebar.webviewProtocol?.request("openSettings", undefined);
    },
    "continue.sendMainUserInput": (text: string) => {
      sidebar.webviewProtocol?.request("userInput", {
        input: text,
      });
    },
    "continue.selectRange": (startLine: number, endLine: number) => {
      if (!vscode.window.activeTextEditor) {
        return;
      }
      vscode.window.activeTextEditor.selection = new vscode.Selection(
        startLine,
        0,
        endLine,
        0,
      );
    },
    "continue.foldAndUnfold": (
      foldSelectionLines: number[],
      unfoldSelectionLines: number[],
    ) => {
      vscode.commands.executeCommand("editor.unfold", {
        selectionLines: unfoldSelectionLines,
      });
      vscode.commands.executeCommand("editor.fold", {
        selectionLines: foldSelectionLines,
      });
    },
    "continue.sendToTerminal": (text: string) => {
      captureCommandTelemetry("sendToTerminal");
      ide.runCommand(text);
    },
    "continue.newSession": () => {
      sidebar.webviewProtocol?.request("newSession", undefined);
    },
    "continue.viewHistory": () => {
      sidebar.webviewProtocol?.request("viewHistory", undefined);
    },
    "continue.toggleFullScreen": () => {
      // Check if full screen is already open by checking open tabs
      const fullScreenTab = getFullScreenTab();

      // Check if the active editor is the Continue GUI View
      if (fullScreenTab && fullScreenTab.isActive) {
        //Full screen open and focused - close it
        vscode.commands.executeCommand("workbench.action.closeActiveEditor"); //this will trigger the onDidDispose listener below
        return;
      }

      if (fullScreenTab && fullScreenPanel) {
        //Full screen open, but not focused - focus it
        fullScreenPanel.reveal();
        return;
      }

      //Full screen not open - open it
      captureCommandTelemetry("openFullScreen");

      // Close the sidebar.webviews
      // vscode.commands.executeCommand("workbench.action.closeSidebar");
      vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      // vscode.commands.executeCommand("workbench.action.toggleZenMode");

      //create the full screen panel
      let panel = vscode.window.createWebviewPanel(
        "continue.continueGUIView",
        "Continue",
        vscode.ViewColumn.One,
        {
          retainContextWhenHidden: true,
        },
      );
      fullScreenPanel = panel;

      //Add content to the panel
      panel.webview.html = sidebar.getSidebarContent(
        extensionContext,
        panel,
        undefined,
        undefined,
        true,
      );

      //When panel closes, reset the webview and focus
      panel.onDidDispose(
        () => {
          sidebar.resetWebviewProtocolWebview();
          vscode.commands.executeCommand("continue.focusContinueInput");
        },
        null,
        extensionContext.subscriptions,
      );
    },
    "continue.openConfigJson": () => {
      ide.openFile(getConfigJsonPath());
    },
    "continue.selectFilesAsContext": (
      firstUri: vscode.Uri,
      uris: vscode.Uri[],
    ) => {
      vscode.commands.executeCommand("continue.continueGUIView.focus");

      for (const uri of uris) {
        addEntireFileToContext(uri, false, sidebar.webviewProtocol);
      }
    },
    "continue.logAutocompleteOutcome": (
      completionId: string,
      completionProvider: CompletionProvider,
    ) => {
      completionProvider.accept(completionId);
    },
    "continue.toggleTabAutocompleteEnabled": () => {
      captureCommandTelemetry("toggleTabAutocompleteEnabled");

      const config = vscode.workspace.getConfiguration("continue");
      const enabled = config.get("enableTabAutocomplete");
      const pauseOnBattery = config.get<boolean>(
        "pauseTabAutocompleteOnBattery",
      );
      if (!pauseOnBattery || battery.isACConnected()) {
        config.update(
          "enableTabAutocomplete",
          !enabled,
          vscode.ConfigurationTarget.Global,
        );
      } else {
        if (enabled) {
          const paused = getStatusBarStatus() === StatusBarStatus.Paused;
          if (paused) {
            setupStatusBar(StatusBarStatus.Enabled);
          } else {
            config.update(
              "enableTabAutocomplete",
              false,
              vscode.ConfigurationTarget.Global,
            );
          }
        } else {
          setupStatusBar(StatusBarStatus.Paused);
          config.update(
            "enableTabAutocomplete",
            true,
            vscode.ConfigurationTarget.Global,
          );
        }
      }
    },
    "continue.openTabAutocompleteConfigMenu": async () => {
      captureCommandTelemetry("openTabAutocompleteConfigMenu");

      const config = vscode.workspace.getConfiguration("continue");
      const quickPick = vscode.window.createQuickPick();
      const selected = new GlobalContext().get("selectedTabAutocompleteModel");
      const autocompleteModelTitles = ((
        await configHandler.loadConfig()
      ).tabAutocompleteModels
        ?.map((model) => model.title)
        .filter((t) => t !== undefined) || []) as string[];

      // Toggle between Disabled, Paused, and Enabled
      const pauseOnBattery =
        config.get<boolean>("pauseTabAutocompleteOnBattery") &&
        !battery.isACConnected();
      const currentStatus = getStatusBarStatus();

      let targetStatus: StatusBarStatus | undefined;
      if (pauseOnBattery) {
        // Cycle from Disabled -> Paused -> Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Paused
            ? StatusBarStatus.Enabled
            : currentStatus === StatusBarStatus.Disabled
              ? StatusBarStatus.Paused
              : StatusBarStatus.Disabled;
      } else {
        // Toggle between Disabled and Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Disabled
            ? StatusBarStatus.Enabled
            : StatusBarStatus.Disabled;
      }
      quickPick.items = [
        {
          label: quickPickStatusText(targetStatus),
        },
        {
          label: "$(gear) Configure autocomplete options",
        },
        {
          label: "$(feedback) Give feedback",
        },
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: "Switch model",
        },
        ...autocompleteModelTitles.map((title) => ({
          label: title === selected ? `$(check) ${title}` : title,
          description: title === selected ? "Currently selected" : undefined,
        })),
      ];
      quickPick.onDidAccept(() => {
        const selectedOption = quickPick.selectedItems[0].label;
        const targetStatus =
          getStatusBarStatusFromQuickPickItemLabel(selectedOption);

        if (targetStatus !== undefined) {
          setupStatusBar(targetStatus);
          config.update(
            "enableTabAutocomplete",
            targetStatus === StatusBarStatus.Enabled,
            vscode.ConfigurationTarget.Global,
          );
        } else if (
          selectedOption === "$(gear) Configure autocomplete options"
        ) {
          ide.openFile(getConfigJsonPath());
        } else if (autocompleteModelTitles.includes(selectedOption)) {
          new GlobalContext().update(
            "selectedTabAutocompleteModel",
            selectedOption,
          );
          configHandler.reloadConfig();
        } else if (selectedOption === "$(feedback) Give feedback") {
          vscode.commands.executeCommand("continue.giveAutocompleteFeedback");
        }
        quickPick.dispose();
      });
      quickPick.show();
    },
    "continue.giveAutocompleteFeedback": async () => {
      const feedback = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        prompt:
          "Please share what went wrong with the last completion. The details of the completion as well as this message will be sent to the Continue team in order to improve.",
      });
      if (feedback) {
        const client = await continueServerClientPromise;
        const completionsPath = getDevDataFilePath("autocomplete");

        const lastLines = await readLastLines.read(completionsPath, 2);
        client.sendFeedback(feedback, lastLines);
      }
    },
    "continue.quickEditHistoryUp": async () => {
      captureCommandTelemetry("quickEditHistoryUp");
      historyUpEventEmitter.fire();
    },
    "continue.quickEditHistoryDown": async () => {
      captureCommandTelemetry("quickEditHistoryDown");
      historyDownEventEmitter.fire();
    },
  };
};

export function registerAllCommands(
  context: vscode.ExtensionContext,
  ide: IDE,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  configHandler: IConfigHandler,
  diffManager: DiffManager,
  verticalDiffManager: VerticalPerLineDiffManager,
  continueServerClientPromise: Promise<ContinueServerClient>,
  battery: Battery,
) {
  for (const [command, callback] of Object.entries(
    commandsMap(
      ide,
      extensionContext,
      sidebar,
      configHandler,
      diffManager,
      verticalDiffManager,
      continueServerClientPromise,
      battery,
    ),
  )) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback),
    );
  }
}
