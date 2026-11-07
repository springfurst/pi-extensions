import type { Frame } from "puppeteer-core";
import type { ManagedTab } from "./types";
import { BrowserPilotError } from "./types";

export interface FrameSelectionState {
  tab: number;
  index: number;
}

/** Per-tab frame selection used by read, eval, and element screenshots. */
export class FrameSelection {
  selected?: FrameSelectionState;

  list(tab: ManagedTab): Array<{
    index: number;
    url: string;
    name: string;
    main: boolean;
    selected: boolean;
  }> {
    const main = tab.page.mainFrame();
    return tab.page.frames().map((frame, index) => ({
      index,
      url: frame.url(),
      name: frame.name(),
      main: frame === main,
      selected: this.selected?.tab === tab.handle && this.selected.index === index,
    }));
  }

  select(tab: ManagedTab, index: number | undefined): Frame {
    if (index === undefined) {
      this.selected = undefined;
      return tab.page.mainFrame();
    }
    const frame = tab.page.frames()[index];
    if (!frame || frame.isDetached()) {
      throw new BrowserPilotError(
        `Frame ${index} is not available in tab ${tab.handle}.`,
        'Run {action:"frames", op:"list"} to see frame indices.',
      );
    }
    this.selected = { tab: tab.handle, index };
    return frame;
  }

  active(tab: ManagedTab): Frame {
    if (!this.selected || this.selected.tab !== tab.handle) {
      return tab.page.mainFrame();
    }
    const frame = tab.page.frames()[this.selected.index];
    if (!frame || frame.isDetached()) return tab.page.mainFrame();
    return frame;
  }

  reset(tabHandle?: number): void {
    if (tabHandle === undefined || this.selected?.tab === tabHandle) this.selected = undefined;
  }
}
