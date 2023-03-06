import { vec2, mat4 } from './my-matrix';
import { createGameMap } from './create-map';
import { BooleanGrid, ItemType, GameMap, Player, TerrainType } from './game-map';
import { GuardMode, guardActAll, lineOfSight } from './guard';
import { Renderer, createRenderer, GlyphRenderer } from './render';
import * as colorPreset from './color-preset';

var fontImageRequire = require('./font.png');
var tilesImageRequire = require('./tiles.png');

window.onload = loadResourcesThenRun;

type Camera = {
    position: vec2;
    velocity: vec2;
}

type State = {
    tLast: number | undefined;
    shiftModifierActive: boolean;
    shiftUpLastTimeStamp: number;
    player: Player;
    finishedLevel: boolean;
    seeAll: boolean;
    seeGuardSight: boolean;
    camera: Camera;
    level: number;
    gameMap: GameMap;
}

function loadResourcesThenRun() {
    Promise.all([
        loadImage(fontImageRequire),
        loadImage(tilesImageRequire),
    ]).then(main);
}

function main(images: Array<HTMLImageElement>) {

    const canvas = document.querySelector("#canvas") as HTMLCanvasElement;

    const renderEngine = 'webgl';

    const renderer = createRenderer(renderEngine, canvas, images);
    const state = initState();

    document.body.addEventListener('keydown', onKeyDown);
    document.body.addEventListener('keyup', onKeyUp);

    function onKeyDown(e: KeyboardEvent) {
        if (e.code == 'KeyF' || e.code == 'NumpadAdd') {
            state.shiftModifierActive = true;
            return;
        }

        if (e.ctrlKey) {
            if (e.code === 'KeyA') {
                e.preventDefault();
                state.seeAll = !state.seeAll;
            } else if (e.code === 'KeyV') {
                e.preventDefault();
                state.seeGuardSight = !state.seeGuardSight;
            }
        } else if (e.code == 'KeyR') {
            e.preventDefault();
            resetState(state);
        } else {
            const distDesired = (state.shiftModifierActive || e.shiftKey || (e.timeStamp - state.shiftUpLastTimeStamp) < 1.0) ? 2 : 1;
            if (e.code == 'ArrowLeft' || e.code == 'Numpad4' || e.code == 'KeyA' || e.code == 'KeyH') {
                e.preventDefault();
                tryMovePlayer(state, -1, 0, distDesired);
            } else if (e.code == 'ArrowRight' || e.code == 'Numpad6' || e.code == 'KeyD' || e.code == 'KeyL') {
                e.preventDefault();
                tryMovePlayer(state, 1, 0, distDesired);
            } else if (e.code == 'ArrowDown' || e.code == 'Numpad2' || e.code == 'KeyS' || e.code == 'KeyJ') {
                e.preventDefault();
                tryMovePlayer(state, 0, -1, distDesired);
            } else if (e.code == 'ArrowUp' || e.code == 'Numpad8' || e.code == 'KeyW' || e.code == 'KeyK') {
                e.preventDefault();
                tryMovePlayer(state, 0, 1, distDesired);
            } else if (e.code == 'Period' || e.code == 'Numpad5' || e.code == 'KeyZ') {
                e.preventDefault();
                tryMovePlayer(state, 0, 0, 1);
            }
        }

        state.shiftModifierActive = false;
    }

    function onKeyUp(e: KeyboardEvent) {
        if (e.code == 'ShiftLeft' || e.code == 'ShiftRight') {
            state.shiftUpLastTimeStamp = e.timeStamp;
        }
    }

    function requestUpdateAndRender() {
        requestAnimationFrame(now => updateAndRender(now, renderer, state));
    }

    function onWindowResized() {
        requestUpdateAndRender();
    }

    window.addEventListener('resize', onWindowResized);

    requestUpdateAndRender();
}

function advanceToNextLevel(state: State) {
    state.level += 1;
    state.gameMap = createGameMap(state.level);
    state.finishedLevel = false;

    state.player.pos = state.gameMap.playerStartPos;
    state.player.dir = vec2.fromValues(0, -1);
    state.player.gold = 0;
    state.player.noisy = false;
    state.player.damagedLastTurn = false;
    state.player.turnsRemainingUnderwater = 0;

    state.camera = createCamera(state.gameMap.playerStartPos);

    state.gameMap.recomputeVisibility(state.player.pos);
}

function tryMovePlayer(state: State, dx: number, dy: number, distDesired: number) {

    const player = state.player;

    // Can't move if you're dead.

    if (player.health <= 0) {
        return;
    }

    // If just passing time, do that.

    if ((dx === 0 && dy === 0) || distDesired <= 0) {
        preTurn(state);
        advanceTime(state);
        return;
    }

    let dist = playerMoveDistAllowed(state, dx, dy, distDesired);
    if (dist <= 0) {
        const posBump = vec2.fromValues(player.pos[0] + dx * (dist + 1), player.pos[1] + dy * (dist + 1));
        const item = state.gameMap.items.find((item) => item.pos[0] === posBump[0] && item.pos[1] === posBump[1]);
        if (item !== undefined && (item.type === ItemType.TorchUnlit || item.type === ItemType.TorchLit)) {
            preTurn(state);
            item.type = (item.type === ItemType.TorchUnlit) ? ItemType.TorchLit : ItemType.TorchUnlit;
            state.gameMap.computeLighting();
            advanceTime(state);
        }
        return;
    }

    // Execute the move. Collect loot along the way; advance to next level when moving off the edge.

    preTurn(state);

    for (; dist > 0; --dist) {
        player.pos[0] += dx;
        player.pos[1] += dy;

        if (player.pos[0] < 0 ||
            player.pos[1] < 0 ||
            player.pos[0] >= state.gameMap.cells.sizeX ||
            player.pos[1] >= state.gameMap.cells.sizeY) {
            advanceToNextLevel(state);
            return;
        }

        player.gold += state.gameMap.collectLootAt(player.pos[0], player.pos[1]);
    }

    // Generate movement noises.

    let cellType = state.gameMap.cells.at(player.pos[0], player.pos[1]).type;
    if (cellType == TerrainType.GroundWoodCreaky) {
        makeNoise(state.gameMap, player, 17 /*, state.gameMap.popups, "\u{ab}creak\u{bb}" */);
    }

    advanceTime(state);
}

function playerMoveDistAllowed(state: State, dx: number, dy: number, maxDist: number): number {
    const player = state.player;

    let posPrev = vec2.clone(player.pos);

    let distAllowed = 0;

    for (let d = 1; d <= maxDist; ++d) {
        const pos = vec2.fromValues(player.pos[0] + dx * d, player.pos[1] + dy * d);

        if (pos[0] < 0 ||
            pos[1] < 0 ||
            pos[0] >= state.gameMap.cells.sizeX ||
            pos[1] >= state.gameMap.cells.sizeY) {
            if (state.gameMap.allSeen() && state.gameMap.allLootCollected()) {
                distAllowed = d;
            }
            break;
        } else if (blocked(state.gameMap, posPrev, pos)) {
            break;
        } else {
            distAllowed = d;
        }

        posPrev = pos;
    }

    // If the move would end on a guard, reject it

    if (distAllowed > 0) {
        const pos = vec2.fromValues(player.pos[0] + dx * distAllowed, player.pos[1] + dy * distAllowed);
        if (state.gameMap.guards.find((guard) => guard.pos[0] == pos[0] && guard.pos[1] == pos[1]) !== undefined) {
            distAllowed = 0;
        }
    }

    // If the move would end on a torch, shorten it

    if (distAllowed > 0) {
        const pos = vec2.fromValues(player.pos[0] + dx * distAllowed, player.pos[1] + dy * distAllowed);
        if (state.gameMap.items.find((item) => item.pos[0] === pos[0] && item.pos[1] === pos[1] &&
                (item.type === ItemType.TorchUnlit || item.type === ItemType.TorchLit)) !== undefined) {
            --distAllowed;
        }
    }

    return distAllowed;
}

function makeNoise(map: GameMap, player: Player, radius: number /*, popups: &mut Popups, noise: &'static str */) {
    player.noisy = true;
    /* TODO
    popups.noise(player.pos, noise);
    */

    for (const guard of map.guardsInEarshot(player.pos, radius)) {
        guard.heardThief = true;
    }
}

function preTurn(state: State) {
    /* TODO
    state.show_msgs = true;
    state.popups.clear();
    */
    state.player.noisy = false;
    state.player.damagedLastTurn = false;
}

function advanceTime(state: State) {
    if (state.gameMap.cells.at(state.player.pos[0], state.player.pos[1]).type == TerrainType.GroundWater) {
        if (state.player.turnsRemainingUnderwater > 0) {
            --state.player.turnsRemainingUnderwater;
        }
    } else {
        state.player.turnsRemainingUnderwater = 7;
    }

    guardActAll(/* state.popups, state.lines, */ state.gameMap, state.player);

    state.gameMap.recomputeVisibility(state.player.pos);

    if (state.gameMap.allSeen() && state.gameMap.allLootCollected()) {
        state.finishedLevel = true;
    }
}

function blocked(map: GameMap, posOld: vec2, posNew: vec2): boolean {
    if (posNew[0] < 0 || posNew[1] < 0 || posNew[0] >= map.cells.sizeX || posNew[1] >= map.cells.sizeY) {
        return true;
    }

    if (posOld[0] == posNew[0] && posOld[1] == posNew[1]) {
        return false;
    }

    const cell = map.cells.at(posNew[0], posNew[1]);
    const tileType = cell.type;

    if (cell.blocksPlayerMove) {
        return true;
    }

    if (tileType == TerrainType.OneWayWindowE && posNew[0] <= posOld[0]) {
        return true;
    }

    if (tileType == TerrainType.OneWayWindowW && posNew[0] >= posOld[0]) {
        return true;
    }

    if (tileType == TerrainType.OneWayWindowN && posNew[1] <= posOld[1]) {
        return true;
    }

    if (tileType == TerrainType.OneWayWindowS && posNew[1] >= posOld[1]) {
        return true;
    }

    return false;
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

const altTileIndexForTerrainType: Array<[number, number]> = [
    [1, 4], // TerrainType.GroundNormal,
    [7, 3], // TerrainType.GroundGrass,
    [7, 7], // TerrainType.GroundWater,
    [1, 4], // TerrainType.GroundMarble,
    [1, 4], // TerrainType.GroundWood,
    [1, 4], // TerrainType.GroundWoodCreaky,
    [0, 0], // TerrainType.Wall0000,
    [3, 2], // TerrainType.Wall0001,
    [3, 3], // TerrainType.Wall0010,
    [3, 5], // TerrainType.Wall0011,
    [3, 1], // TerrainType.Wall0100,
    [2, 3], // TerrainType.Wall0101,
    [2, 1], // TerrainType.Wall0110,
    [2, 5], // TerrainType.Wall0111,
    [3, 0], // TerrainType.Wall1000,
    [2, 3], // TerrainType.Wall1001,
    [2, 2], // TerrainType.Wall1010,
    [2, 4], // TerrainType.Wall1011,
    [3, 4], // TerrainType.Wall1100,
    [2, 7], // TerrainType.Wall1101,
    [2, 8], // TerrainType.Wall1110,
    [0, 0], // TerrainType.Wall1111,
    [0, 4], // TerrainType.OneWayWindowE,
    [0, 3], // TerrainType.OneWayWindowW,
    [0, 2], // TerrainType.OneWayWindowN,
    [1, 2], // TerrainType.OneWayWindowS,
    [1, 0], // TerrainType.PortcullisNS,
    [1, 1], // TerrainType.PortcullisEW,
    [0, 5], // TerrainType.DoorNS,
    [0, 6], // TerrainType.DoorEW,

];

const tileIndexForTerrainType: Array<number> = [
    112, // TerrainType.GroundNormal,
    116, // TerrainType.GroundGrass,
    118, // TerrainType.GroundWater,
    120, // TerrainType.GroundMarble,
    122, // TerrainType.GroundWood,
    122, // TerrainType.GroundWoodCreaky,
    64, // TerrainType.Wall0000,
    65, // TerrainType.Wall0001,
    65, // TerrainType.Wall0010,
    65, // TerrainType.Wall0011,
    66, // TerrainType.Wall0100,
    67, // TerrainType.Wall0101,
    70, // TerrainType.Wall0110,
    73, // TerrainType.Wall0111,
    66, // TerrainType.Wall1000,
    68, // TerrainType.Wall1001,
    69, // TerrainType.Wall1010,
    72, // TerrainType.Wall1011,
    66, // TerrainType.Wall1100,
    74, // TerrainType.Wall1101,
    71, // TerrainType.Wall1110,
    75, // TerrainType.Wall1111,
    52, // TerrainType.OneWayWindowE,
    53, // TerrainType.OneWayWindowW,
    54, // TerrainType.OneWayWindowN,
    55, // TerrainType.OneWayWindowS,
    50, // TerrainType.PortcullisNS,
    50, // TerrainType.PortcullisEW,
    77, // TerrainType.DoorNS,
    76, // TerrainType.DoorEW,
];

const colorForTerrainType: Array<number> = [
    colorPreset.lightGray, // TerrainType.GroundNormal,
    colorPreset.darkGreen, // TerrainType.GroundGrass,
    colorPreset.lightBlue, // TerrainType.GroundWater,
    colorPreset.darkCyan, // TerrainType.GroundMarble,
    colorPreset.darkBrown, // TerrainType.GroundWood,
    0xff004070, // TerrainType.GroundWoodCreaky,
    colorPreset.lightGray, // TerrainType.Wall0000,
    colorPreset.lightGray, // TerrainType.Wall0001,
    colorPreset.lightGray, // TerrainType.Wall0010,
    colorPreset.lightGray, // TerrainType.Wall0011,
    colorPreset.lightGray, // TerrainType.Wall0100,
    colorPreset.lightGray, // TerrainType.Wall0101,
    colorPreset.lightGray, // TerrainType.Wall0110,
    colorPreset.lightGray, // TerrainType.Wall0111,
    colorPreset.lightGray, // TerrainType.Wall1000,
    colorPreset.lightGray, // TerrainType.Wall1001,
    colorPreset.lightGray, // TerrainType.Wall1010,
    colorPreset.lightGray, // TerrainType.Wall1011,
    colorPreset.lightGray, // TerrainType.Wall1100,
    colorPreset.lightGray, // TerrainType.Wall1101,
    colorPreset.lightGray, // TerrainType.Wall1110,
    colorPreset.lightGray, // TerrainType.Wall1111,
    colorPreset.lightGray, // TerrainType.OneWayWindowE,
    colorPreset.lightGray, // TerrainType.OneWayWindowW,
    colorPreset.lightGray, // TerrainType.OneWayWindowN,
    colorPreset.lightGray, // TerrainType.OneWayWindowS,
    colorPreset.lightGray, // TerrainType.PortcullisNS,
    colorPreset.lightGray, // TerrainType.PortcullisEW,
    colorPreset.lightGray, // TerrainType.DoorNS,
    colorPreset.lightGray, // TerrainType.DoorEW,
];

const tileIndexForItemType: Array<number> = [
    100, // ItemType.Chair,
    98, // ItemType.Table,
    96, // ItemType.Bush,
    110, // ItemType.Coin,
    89, // ItemType.DoorNS,
    87, // ItemType.DoorEW,
    50, // ItemType.PortcullisNS,
    50, // ItemType.PortcullisEW,
    80, // ItemType.TorchUnlit,
    80, // ItemType.TorchLit,
];

const colorForItemType: Array<number> = [
    colorPreset.darkBrown, // ItemType.Chair,
    colorPreset.darkBrown, // ItemType.Table,
    colorPreset.darkGreen, // ItemType.Bush,
    colorPreset.lightYellow, // ItemType.Coin,
    colorPreset.darkBrown, // ItemType.DoorNS,
    colorPreset.darkBrown, // ItemType.DoorEW,
    colorPreset.lightGray, // ItemType.PortcullisNS,
    colorPreset.lightGray, // ItemType.PortcullisEW,
    colorPreset.darkGray, // ItemType.TorchUnlit,
    colorPreset.lightYellow, // ItemType.TorchLit,
]

const unlitColor: number = colorPreset.lightBlue;

function renderWorld(state: State, glyphRenderer: GlyphRenderer) {
    for (let x = 0; x < state.gameMap.cells.sizeX; ++x) {
        for (let y = 0; y < state.gameMap.cells.sizeY; ++y) {
            const cell = state.gameMap.cells.at(x, y);
            if (!cell.seen && !state.seeAll) {
                continue;
            }
            const terrainType = cell.type;
            const tileIndex = tileIndexForTerrainType[terrainType];
            const alwaysLit = terrainType >= TerrainType.Wall0000;
            const lit = alwaysLit || cell.lit;
            const color = lit ? colorForTerrainType[terrainType] : unlitColor;
            glyphRenderer.addGlyph(x, y, x+1, y+1, tileIndex, color);
        }
    }

    for (const item of state.gameMap.items) {
        const cell = state.gameMap.cells.at(item.pos[0], item.pos[1]);
        if (!cell.seen && !state.seeAll) {
            continue;
        }
        const tileIndex = tileIndexForItemType[item.type];
        const alwaysLit = item.type >= ItemType.DoorNS && item.type <= ItemType.PortcullisEW;
        const lit = alwaysLit || cell.lit;
        const color = lit ? colorForItemType[item.type] : unlitColor;
        glyphRenderer.addGlyph(item.pos[0], item.pos[1], item.pos[0] + 1, item.pos[1] + 1, tileIndex, color);
    }
}

function renderPlayer(state: State, glyphRenderer: GlyphRenderer) {
    const player = state.player;
    const x = player.pos[0];
    const y = player.pos[1];
    const lit = state.gameMap.cells.at(x, y).lit;
    const hidden = player.hidden(state.gameMap);
    const color =
        player.damagedLastTurn ? 0xff0000ff :
        player.noisy ? colorPreset.lightCyan :
        hidden ? 0xd0101010 :
        !lit ? colorPreset.lightBlue :
        colorPreset.lightGray;

    glyphRenderer.addGlyph(x, y, x+1, y+1, 32, color);
}

function renderGuards(state: State, glyphRenderer: GlyphRenderer) {
    for (const guard of state.gameMap.guards) {
        const cell = state.gameMap.cells.at(guard.pos[0], guard.pos[1]);
        const visible = state.seeAll || cell.seen || guard.speaking;
        if (!visible && vec2.squaredDistance(state.player.pos, guard.pos) > 36) {
            continue;
        }

        const tileIndex = 33 + tileIndexOffsetForDir(guard.dir);
        const color =
            !visible ? colorPreset.darkGray :
            (guard.mode == GuardMode.Patrol && !guard.speaking && !cell.lit) ? unlitColor :
            colorPreset.lightMagenta;

        const x = guard.pos[0];
        const y = guard.pos[1];

        glyphRenderer.addGlyph(x, y, x+1, y+1, tileIndex, color);
    }
}

function renderGuardOverheadIcons(state: State, glyphRenderer: GlyphRenderer) {
    for (const guard of state.gameMap.guards) {
        const cell = state.gameMap.cells.at(guard.pos[0], guard.pos[1]);
        const visible = state.seeAll || cell.seen || guard.speaking;
        if (!visible && vec2.squaredDistance(state.player.pos, guard.pos) > 36) {
            continue;
        }

        const tileIndex = guard.overheadIcon();
        if (tileIndex === undefined) {
            continue;
        }

        const x = guard.pos[0];
        const y = guard.pos[1] + 0.625;

        glyphRenderer.addGlyph(x, y, x+1, y+1, tileIndex, colorPreset.lightYellow);
    }
}

function renderGuardSight(state: State, glyphRenderer: GlyphRenderer) {
    if (!state.seeGuardSight) {
        return;
    }

    const mapSizeX = state.gameMap.cells.sizeX;
    const mapSizeY = state.gameMap.cells.sizeY;

    const seenByGuard = new BooleanGrid(mapSizeX, mapSizeY, false);

    const pos = vec2.create();
    const dpos = vec2.create();

    for (const guard of state.gameMap.guards) {
        const maxSightCutoff = 3;
        const xMin = Math.max(0, Math.floor(guard.pos[0] - maxSightCutoff));
        const xMax = Math.min(mapSizeX, Math.floor(guard.pos[0] + maxSightCutoff) + 1);
        const yMin = Math.max(0, Math.floor(guard.pos[1] - maxSightCutoff));
        const yMax = Math.min(mapSizeY, Math.floor(guard.pos[1] + maxSightCutoff) + 1);
        for (let y = yMin; y < yMax; ++y) {
            for (let x = xMin; x < xMax; ++x) {
                vec2.set(pos, x, y);
                vec2.subtract(dpos, pos, guard.pos);
                const cell = state.gameMap.cells.at(x, y);

                if (seenByGuard.get(x, y)) {
                    continue;
                }
                if (cell.blocksPlayerMove) {
                    continue;
                }
                if (!state.seeAll && !cell.seen) {
                    continue;
                }
                if (vec2.dot(guard.dir, dpos) < 0) {
                    continue;
                }
                if (vec2.squaredLength(dpos) >= guard.sightCutoff(cell.lit)) {
                    continue;
                }
                if (!lineOfSight(state.gameMap, guard.pos, pos)) {
                    continue;
                }
        
                seenByGuard.set(x, y, true);
            }
        }
    }

    for (let y = 0; y < state.gameMap.cells.sizeY; ++y) {
        for (let x = 0; x < state.gameMap.cells.sizeX; ++x) {
            if (seenByGuard.get(x, y)) {
                glyphRenderer.addGlyph(x, y, x+1, y+1, 15, 0xa0004080);
            }
        }
    }
}

function tileIndexOffsetForDir(dir: vec2): number {
    if (dir[1] > 0) {
        return 1;
    } else if (dir[1] < 0) {
        return 3;
    } else if (dir[0] > 0) {
        return 0;
    } else if (dir[0] < 0) {
        return 2;
    } else {
        return 3;
    }
}

function createCamera(posPlayer: vec2): Camera {
    const camera = {
        position: vec2.create(),
        velocity: vec2.create(),
    };

    vec2.copy(camera.position, posPlayer);
    vec2.zero(camera.velocity);

    return camera;
}

function initState(): State {
    const initialLevel = 0;
    const gameMap = createGameMap(initialLevel);

    return {
        tLast: undefined,
        shiftModifierActive: false,
        shiftUpLastTimeStamp: -Infinity,
        player: new Player(gameMap.playerStartPos),
        finishedLevel: false,
        seeAll: false,
        seeGuardSight: false,
        camera: createCamera(gameMap.playerStartPos),
        level: initialLevel,
        gameMap: gameMap,
    };
}

function resetState(state: State) {
    const gameMap = createGameMap(state.level);

    state.finishedLevel = false;
    state.player = new Player(gameMap.playerStartPos);
    state.camera = createCamera(gameMap.playerStartPos);
    state.gameMap = gameMap;
}

function updateAndRender(now: number, renderer: Renderer, state: State) {
    const t = now / 1000;
    const dt = (state.tLast === undefined) ? 0 : Math.min(1/30, t - state.tLast);
    state.tLast = t;

    if (dt > 0) {
        updateState(state, dt);
    }

    renderScene(renderer, state);

    requestAnimationFrame(now => updateAndRender(now, renderer, state));
}

function updateState(state: State, dt: number) {
    updateCamera(state, dt);
}

function updateCamera(state: State, dt: number) {

    // Update player follow

    const posError = vec2.create();
    vec2.subtract(posError, state.player.pos, state.camera.position);

    const velError = vec2.create();
    vec2.negate(velError, state.camera.velocity);

    const kSpring = 8; // spring constant, radians/sec

    const acc = vec2.create();
    vec2.scale(acc, posError, kSpring**2);
    vec2.scaleAndAdd(acc, acc, velError, 2*kSpring);

    const velNew = vec2.create();
    vec2.scaleAndAdd(velNew, state.camera.velocity, acc, dt);

    vec2.scaleAndAdd(state.camera.position, state.camera.position, state.camera.velocity, 0.5 * dt);
    vec2.scaleAndAdd(state.camera.position, state.camera.position, velNew, 0.5 * dt);
    vec2.copy(state.camera.velocity, velNew);
}

function renderScene(renderer: Renderer, state: State) {
    const screenSize = vec2.create();
    renderer.beginFrame(screenSize, [state.gameMap.cells.sizeX, state.gameMap.cells.sizeY]);

    const matScreenFromWorld = mat4.create();
    setupViewMatrix(state, screenSize, matScreenFromWorld);

    renderer.renderGlyphs.start(matScreenFromWorld, 1);
    renderWorld(state, renderer.renderGlyphs);
    renderPlayer(state, renderer.renderGlyphs);
    renderGuards(state, renderer.renderGlyphs);
    renderGuardOverheadIcons(state, renderer.renderGlyphs);
    renderGuardSight(state, renderer.renderGlyphs);
    renderer.renderGlyphs.flush();
}

function setupViewMatrix(state: State, screenSize: vec2, matScreenFromWorld: mat4) {
    const pixelsPerTileX = 16; // width of unzoomed tile
    const pixelsPerTileY = 16; // height of unzoomed tile

    const viewTileSizeDesiredX = 32; // desired minimum viewport tile width
    const viewTileSizeDesiredY = 32; // desired minimum viewport tile height

    const viewPixelSizeDesiredX = viewTileSizeDesiredX * pixelsPerTileX;
    const viewPixelSizeDesiredY = viewTileSizeDesiredY * pixelsPerTileY;

    let tileZoom;
    if (screenSize[0] * viewPixelSizeDesiredY < screenSize[1] * viewPixelSizeDesiredX) {
        tileZoom = Math.max(1, Math.floor(screenSize[0] / viewPixelSizeDesiredX + 0.5));
    } else {
        tileZoom = Math.max(1, Math.floor(screenSize[1] / viewPixelSizeDesiredY + 0.5));
    }

    const zoomedPixelsPerTileX = pixelsPerTileX * tileZoom;
    const zoomedPixelsPerTileY = pixelsPerTileY * tileZoom;

    const viewWorldSizeX = screenSize[0] / zoomedPixelsPerTileX;
    const viewWorldSizeY = screenSize[1] / zoomedPixelsPerTileY;

    const viewWorldCenterX = state.camera.position[0] + 0.5;
    const viewWorldCenterY = state.camera.position[1] + 0.5;

    const viewWorldMinX = viewWorldCenterX - viewWorldSizeX / 2;
    const viewWorldMinY = viewWorldCenterY - viewWorldSizeY / 2;

    mat4.ortho(
        matScreenFromWorld,
        viewWorldMinX,
        viewWorldMinX + viewWorldSizeX,
        viewWorldMinY,
        viewWorldMinY + viewWorldSizeY,
        1,
        -1
    );
}

function renderTextLines(renderer: Renderer, screenSize: vec2, lines: Array<string>) {
    let maxLineLength = 0;
    for (const line of lines) {
        maxLineLength = Math.max(maxLineLength, line.length);
    }

    const minCharsX = 40;
    const minCharsY = 22;
    const scaleLargestX = Math.max(1, Math.floor(screenSize[0] / (8 * minCharsX)));
    const scaleLargestY = Math.max(1, Math.floor(screenSize[1] / (16 * minCharsY)));
    const scaleFactor = Math.min(scaleLargestX, scaleLargestY);
    const pixelsPerCharX = 8 * scaleFactor;
    const pixelsPerCharY = 16 * scaleFactor;
    const linesPixelSizeX = maxLineLength * pixelsPerCharX;
    const numCharsX = screenSize[0] / pixelsPerCharX;
    const numCharsY = screenSize[1] / pixelsPerCharY;
    const offsetX = Math.floor((screenSize[0] - linesPixelSizeX) / -2) / pixelsPerCharX;
    const offsetY = (lines.length + 2) - numCharsY;

    const matScreenFromTextArea = mat4.create();
    mat4.ortho(
        matScreenFromTextArea,
        offsetX,
        offsetX + numCharsX,
        offsetY,
        offsetY + numCharsY,
        1,
        -1);
    renderer.renderGlyphs.start(matScreenFromTextArea, 0);

    const colorText = 0xffeeeeee;
    const colorBackground = 0xe0555555;

    // Draw a stretched box to make a darkened background for the text.
    renderer.renderGlyphs.addGlyph(
        -1, -1, maxLineLength + 1, lines.length + 1,
        219,
        colorBackground
    );

    for (let i = 0; i < lines.length; ++i) {
        const row = lines.length - (1 + i);
        for (let j = 0; j < lines[i].length; ++j) {
            const col = j;
            const ch = lines[i];
            if (ch === ' ') {
                continue;
            }
            const glyphIndex = lines[i].charCodeAt(j);
            renderer.renderGlyphs.addGlyph(
                col, row, col + 1, row + 1,
                glyphIndex,
                colorText
            );
        }
    }

    renderer.renderGlyphs.flush();
}
