import { Page, expect } from "@playwright/test";
import AreaEditor from "./map-editor/areaEditor";
import EntityEditor from "./map-editor/entityEditor";
import MapEditor from "./mapeditor";
import Menu from "./menu";

interface Coordinates {
  x: number;
  y: number;
}

class Thematics {
  private areaSize: { topLeft: Coordinates; bottomRight: Coordinates } = {
    topLeft: { x: 1, y: 5 },
    bottomRight: { x: 9 * 32 * 1.5, y: 4 * 32 * 1.5 },
  };

  public entityPositionInArea: Coordinates = { x: 6 * 32, y: 3 * 32 };

  public mouseCoordinatesToClickOnEntityInsideArea = {
    x: this.entityPositionInArea.x + 16,
    y: this.entityPositionInArea.y,
  };

  async openAreaEditorAndAddAreaWithRights(page, writeRights: string[] = [], readRights: string[] = []) {
    await MapEditor.openAreaEditor(page);
    await AreaEditor.drawArea(page, this.areaSize.topLeft, this.areaSize.bottomRight);
    await AreaEditor.setAreaRightProperty(page, writeRights, readRights);
  }

  async openEntityEditorAndAddEntityWithOpenLinkPropertyInsideArea(page) {
    await MapEditor.openEntityEditor(page);
    await EntityEditor.selectEntity(page, 0, "small table");
    await EntityEditor.moveAndClick(page, this.entityPositionInArea.x, this.entityPositionInArea.y);
    await EntityEditor.clearEntitySelection(page);
    await EntityEditor.moveAndClick(
      page,
      this.mouseCoordinatesToClickOnEntityInsideArea.x,
      this.mouseCoordinatesToClickOnEntityInsideArea.y
    );
    await EntityEditor.addProperty(page, "Open Link");
    await page.getByPlaceholder("https://workadventu.re").first().fill("https://workadventu.re");
    await Menu.closeMapEditor(page);
    await EntityEditor.moveAndClick(
      page,
      this.mouseCoordinatesToClickOnEntityInsideArea.x,
      this.mouseCoordinatesToClickOnEntityInsideArea.y
    );
    await expect(page.locator(".actions-menu .actions button").nth(0)).toContainText("Open Link");
  }
}

export default new Thematics();
