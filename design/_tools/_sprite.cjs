/**
 * 官方图标 JSON → assets/icons.svg（<symbol> 集合）
 *
 * 用法： node design/_tools/_sprite.cjs
 * 输入： design/_tools/_icons.json（由 _icon_dump.cjs 生成）
 * 产物： design/assets/icons.svg（被 render.cjs 内联进每屏）
 */
const fs = require("fs");

const ROOT = "E:\\Workplace\\extension\\dsh-GOkifu-compact\\design";
const icons = JSON.parse(fs.readFileSync(ROOT + "\\_tools\\_icons.json", "utf8"));

/** 可读 id → 官方组件名 */
const map = {
  "panel-left": "IconPanelLeftOutlineRegular",
  "new-chat": "IconNewChatOutlineRegular",
  search: "IconSearchOutlineRegular",
  settings: "IconSettingsOutlineRegular",
  plugin: "IconPluginPinwheelOutlineRegular",
  "alarm-clock": "IconAlarmClockOutlineRegular",
  compact: "IconCompactOutlineRegular",
  "chevron-down": "IconChevronDownOutlineRegular",
  "chevron-right": "IconChevronRightOutlineRegular",
  "chevron-up": "IconChevronUpOutlineRegular",
  check: "IconCheckOutlineRegular",
  archive: "IconArchiveOutlineRegular",
  ellipsis: "IconEllipsisOutlineRegular",
  plus: "IconPlusOutlineRegular",
  send: "IconSendOutlineRegular",
  paperclip: "IconPaperclipOutlineRegular",
  "folder-open": "IconFolderOpenOutlineRegular",
  close: "IconCloseOutlineRegular",
  sliders: "IconSlidersTwoOutlineRegular",
  question: "IconQuestionOutlineRegular",
  trash: "IconTrashOutlineRegular",
  refresh: "IconRefreshOutlineRegular",
  info: "IconInfoOutlineRegular",
  warning: "IconWarningTriangleOutlineRegular",
  "check-circle": "IconCheckCircleOutlineRegular",
  clock: "IconClockOutlineRegular",
  gauge: "IconGaugeOutlineRegular",
  queue: "IconQueueOutlineRegular",
  edit: "IconEditOutlineRegular",
  "context-injection": "IconContextInjectionOutlineRegular",
  checklist: "IconChecklistOutlineRegular",
  "workspace-tree": "IconWorkspaceTreeOutlineRegular",
  dark: "IconDarkOutlineRegular",
  light: "IconLightOutlineRegular",
  "follow-system": "IconFollowsystemOutlineRegular",
  loading: "IconLoadingOutlineRegular"
};

const symbols = [];
for (const [id, key] of Object.entries(map)) {
  const ic = icons[key];
  if (!ic || !ic.paths || !ic.paths.length) {
    console.error("MISSING " + key);
    continue;
  }
  const paths = ic.paths.map((d) => "    <path d=\"" + d + "\"/>").join("\n");
  symbols.push('  <symbol id="i-' + id + '" viewBox="' + ic.viewBox + '">\n' + paths + "\n  </symbol>");
}

const sprite = [
  '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"',
  '     style="position:absolute;width:0;height:0;overflow:hidden"',
  '     fill="none" stroke="currentColor" stroke-width="1"',
  '     stroke-linecap="round" stroke-linejoin="round">',
  symbols.join("\n"),
  "</svg>"
].join("\n");

fs.writeFileSync(ROOT + "\\assets\\icons.svg", sprite, "utf8");
console.log("symbols=" + symbols.length + " bytes=" + Buffer.byteLength(sprite));
