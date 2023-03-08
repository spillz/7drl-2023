export { Guard, GuardMode, guardActAll, lineOfSight };

import { Float64Grid, GameMap, Item, ItemType, Player, TerrainType, GuardStates } from './game-map';
import { vec2 } from './my-matrix';
import { randomInRange } from './random';

enum MoveResult {
    StoodStill,
    Moved,
    BumpedPlayer,
}

enum GuardMode {
    Patrol,
    Look,
    Listen,
    ChaseVisibleTarget,
    MoveToLastSighting,
    MoveToLastSound,
    MoveToGuardShout,
    RelightTorch,
    PostRelightTorch,
}

class Guard {
    pos: vec2;
    dir: vec2;
    mode: GuardMode;
    hasTorch: boolean;
    speaking: boolean;
    hasMoved: boolean;
    heardThief: boolean;
    hearingGuard: boolean;
    heardGuard: boolean;
    heardGuardPos: vec2;

    // Chase
    goal: vec2;
    modeTimeout: number;

    // Patrol
    patrolPath: Array<vec2>;
    patrolPathIndex: number;
    patrolReverse: boolean;
    patrolLoops: boolean;

    constructor(patrolPath: Array<vec2>, map: GameMap) {
        const posStart = patrolPath[0];
        this.pos = vec2.clone(posStart);
        this.dir = vec2.fromValues(1, 0);
        this.mode = GuardMode.Patrol;
        this.hasTorch = false;
        this.speaking = false;
        this.hasMoved = false;
        this.heardThief = false;
        this.hearingGuard = false;
        this.heardGuard = false;
        this.heardGuardPos = vec2.clone(posStart);
        this.goal = vec2.clone(posStart);
        this.modeTimeout = 0;
        this.patrolPath = patrolPath;
        this.patrolPathIndex = 0;
        this.patrolReverse = false;
        this.patrolLoops = patrolPathLoops(patrolPath);

        this.updateDirInitial();
    }

    overheadIcon(): number {
        if (isRelaxedGuardMode(this.mode)) {
            return GuardStates.Relaxed;
        }
    
        return (this.mode == GuardMode.ChaseVisibleTarget) ? GuardStates.Chasing : GuardStates.Alerted;
    }

    act(/* popups: Popups, lines: Lines, */ player: Player, map: GameMap, shouts: Array<Shout>) {
        const modePrev = this.mode;
        const posPrev = vec2.clone(this.pos);
    
        // See if senses will kick us into a new mode

        if (!isRelaxedGuardMode(this.mode)) {
            if (this.seesThief(map, player)) {
                vec2.copy(this.goal, player.pos);
                this.mode = GuardMode.ChaseVisibleTarget;
            } else if (this.mode === GuardMode.ChaseVisibleTarget) {
                vec2.copy(this.goal, player.pos);
                this.mode = GuardMode.MoveToLastSighting;
                this.modeTimeout = 3;
            }
        }

        if (this.mode !== GuardMode.ChaseVisibleTarget) {
            if (this.heardGuard) {
                this.mode = GuardMode.MoveToGuardShout;
                this.modeTimeout = 2 + randomInRange(4);
                vec2.copy(this.goal, this.heardGuardPos);
            }
    
            if (this.heardThief) {
                if (this.adjacentTo(player.pos)) {
                    this.mode = GuardMode.ChaseVisibleTarget;
                    vec2.copy(this.goal, player.pos);
                } else if (isRelaxedGuardMode(this.mode)) {
                    this.mode = GuardMode.Listen;
                    this.modeTimeout = 2 + randomInRange(4);
                    updateDir(this.dir, this.pos, player.pos);
                } else {
                    this.mode = GuardMode.MoveToLastSound;
                    this.modeTimeout = 2 + randomInRange(4);
                    vec2.copy(this.goal, player.pos);
                }
            }
        }
    
        // Pass time in the current mode
    
        switch (this.mode) {
        case GuardMode.Patrol:
            this.patrolStep(map, player);
            break;

        case GuardMode.Look:
        case GuardMode.Listen:
            this.modeTimeout -= 1;
            if (this.modeTimeout == 0) {
                this.mode = GuardMode.Patrol;
            }
            break;

        case GuardMode.ChaseVisibleTarget:
            if (this.adjacentTo(player.pos)) {
                updateDir(this.dir, this.pos, this.goal);
                if (modePrev == GuardMode.ChaseVisibleTarget) {
                    if (!player.damagedLastTurn) {
                        /* TODO
                        popups.damage(this.pos, lines.damage.next());
                        */
                    }
                    player.applyDamage(1);
                }
            } else {
                this.moveTowardPosition(this.goal, map, player);
            }
            break;

        case GuardMode.MoveToLastSighting:
        case GuardMode.MoveToLastSound:
        case GuardMode.MoveToGuardShout:
            if (this.moveTowardPosition(this.goal, map, player) !== MoveResult.Moved) {
                this.modeTimeout -= 1;
            }

            if (this.modeTimeout == 0) {
                this.mode = GuardMode.Patrol;
            }
            break;

        case GuardMode.RelightTorch:
            if (this.adjacentTo(this.goal)) {
                relightTorchAt(map, this.goal);
                this.mode = GuardMode.PostRelightTorch;
                this.modeTimeout = 3;
            } else if (this.moveTowardPosition(this.goal, map, player) !== MoveResult.Moved) {
                this.modeTimeout -= 1;
                if (this.modeTimeout === 0) {
                    this.mode = GuardMode.Patrol;
                }
            }
            break;

        case GuardMode.PostRelightTorch:
            --this.modeTimeout;
            if (this.modeTimeout <= 0) {
                this.mode = GuardMode.Patrol;
            }
            break;
        }
    
        // If we moved, update state based on target visibility from new position
    
        if (this.pos[0] != posPrev[0] || this.pos[1] != posPrev[1]) {
            if (this.seesThief(map, player)) {
                if (isRelaxedGuardMode(this.mode) && !this.adjacentTo(player.pos)) {
                    this.mode = GuardMode.Look;
                    this.modeTimeout = 2 + randomInRange(4);
                } else {
                    vec2.copy(this.goal, player.pos);
                    updateDir(this.dir, this.pos, this.goal);
                    this.mode = GuardMode.ChaseVisibleTarget;
                }
            } else if (this.mode == GuardMode.ChaseVisibleTarget) {
                vec2.copy(this.goal, player.pos);
                this.mode = GuardMode.MoveToLastSighting;
                this.modeTimeout = 3;
            } else if (this.mode === GuardMode.Patrol) {
                const torch = torchNeedingRelighting(map, this.pos);
                if (torch !== undefined) {
                    vec2.copy(this.goal, torch.pos);
                    this.mode = GuardMode.RelightTorch;
                    this.modeTimeout = 3;
                }
            }
        }
    
        // Clear heard-thief flag
    
        this.heardThief = false;
    
        // Say something to indicate state changes

        /* TODO
        if (let Some(line_iter) = lines_for_state_change(lines, modePrev, this.mode)) {
            this.say(popups, player, see_all, line_iter.next());
        }
        */
    
        if (this.mode == GuardMode.ChaseVisibleTarget && modePrev != GuardMode.ChaseVisibleTarget) {
            shouts.push({pos_shouter: this.pos, pos_target: player.pos});
        }
    }

    adjacentTo(pos: vec2): boolean {
        const dx = pos[0] - this.pos[0];
        const dy = pos[1] - this.pos[1];
        return Math.abs(dx) < 2 && Math.abs(dy) < 2;
    }

    seesThief(map: GameMap, player: Player): boolean {
        const d = vec2.create();
        vec2.subtract(d, player.pos, this.pos);
        if (vec2.dot(this.dir, d) < 0) {
            return false;
        }
    
        let playerIsLit = map.cells.at(player.pos[0], player.pos[1]).lit;
    
        let d2 = vec2.squaredLength(d);
        if (d2 >= this.sightCutoff(playerIsLit)) {
            return false;
        }
    
        if (!player.hidden(map) && lineOfSight(map, this.pos, player.pos)) {
            return true;
        }
    
        if (!isRelaxedGuardMode(this.mode) && Math.abs(d[0]) < 2 && Math.abs(d[1]) < 2) {
            return true;
        }
    
        return false;
    }

    cutoffLit(): number {
        return (isRelaxedGuardMode(this.mode)) ? 40 : 75;
    }
    
    cutoffUnlit(): number {
        return (isRelaxedGuardMode(this.mode)) ? 3 : 33;
    }
    
    sightCutoff(litTarget: boolean): number {
        return litTarget ? this.cutoffLit() : this.cutoffUnlit();
    }

    patrolStep(map: GameMap, player: Player) {
        let moveResult;

        if (this.patrolPath[this.patrolPathIndex][0] === this.pos[0] &&
            this.patrolPath[this.patrolPathIndex][1] === this.pos[1]) {
            if (this.patrolReverse) {
                if (this.patrolPathIndex === 0) {
                    if (this.patrolLoops) {
                        this.patrolPathIndex = this.patrolPath.length - 1;
                    } else {
                        this.patrolReverse = false;
                        this.patrolPathIndex = 1;
                    }
                } else {
                    --this.patrolPathIndex;
                }
            } else {
                if (this.patrolPathIndex >= this.patrolPath.length - 1) {
                    if (this.patrolLoops) {
                        this.patrolPathIndex = 0;
                    } else {
                        this.patrolReverse = true;
                        this.patrolPathIndex = this.patrolPath.length - 2;
                    }
                } else {
                    ++this.patrolPathIndex;
                }
            }

            moveResult = this.moveTowardPosition(this.patrolPath[this.patrolPathIndex], map, player);
        } else {
            moveResult = this.moveTowardPatrolPath(map, player);

            for (let iPatrolPos = 0; iPatrolPos < this.patrolPath.length; ++iPatrolPos) {
                const pos = this.patrolPath[iPatrolPos];
                if (pos[0] === this.pos[0] && pos[1] === this.pos[1]) {
                    this.patrolPathIndex = iPatrolPos;
                    break;
                }
            }
        }

        if (moveResult === MoveResult.BumpedPlayer) {
            this.mode = GuardMode.ChaseVisibleTarget;
            vec2.copy(this.goal, player.pos);
            updateDir(this.dir, this.pos, this.goal);
        }
    }

    updateDirInitial()
    {
        let patrolPathIndexNext;
        if (this.patrolReverse) {
            if (this.patrolPathIndex === 0) {
                if (this.patrolLoops) {
                    patrolPathIndexNext = this.patrolPath.length - 1;
                } else {
                    patrolPathIndexNext = 1;
                }
            } else {
                patrolPathIndexNext = this.patrolPathIndex - 1;
            }
        } else {
            if (this.patrolPathIndex >= this.patrolPath.length - 1) {
                if (this.patrolLoops) {
                    patrolPathIndexNext = 0;
                } else {
                    patrolPathIndexNext = this.patrolPath.length - 2;
                }
            } else {
                patrolPathIndexNext = this.patrolPathIndex + 1;
            }
        }

        updateDir(this.dir, this.pos, this.patrolPath[patrolPathIndexNext]);
    }

    moveTowardPosition(posGoal: vec2, map: GameMap, player: Player): MoveResult {
        const distanceField = map.computeDistancesToPosition(posGoal);
        const posNext = posNextBest(map, distanceField, this.pos);

        if (posNext[0] == this.pos[0] && posNext[1] == this.pos[1]) {
            return MoveResult.StoodStill;
        }

        updateDir(this.dir, this.pos, posNext);

        if (player.pos[0] == posNext[0] && player.pos[1] == posNext[1]) {
            return MoveResult.BumpedPlayer;
        }

        vec2.copy(this.pos, posNext);
        return MoveResult.Moved;
    }

    moveTowardPatrolPath(map: GameMap, player: Player): MoveResult {
        const distanceField = map.computeDistancesToPatrolPath(this.patrolPath);
        const posNext = posNextBest(map, distanceField, this.pos);

        if (posNext[0] == this.pos[0] && posNext[1] == this.pos[1]) {
            return MoveResult.StoodStill;
        }

        updateDir(this.dir, this.pos, posNext);

        if (player.pos[0] == posNext[0] && player.pos[1] == posNext[1]) {
            return MoveResult.BumpedPlayer;
        }

        vec2.copy(this.pos, posNext);
        return MoveResult.Moved;
    }
}

function isRelaxedGuardMode(guardMode: GuardMode): boolean {
    return guardMode === GuardMode.Patrol ||
        guardMode === GuardMode.RelightTorch ||
        guardMode === GuardMode.PostRelightTorch;
}

type Shout = {
    pos_shouter: vec2; // where is the person shouting?
    pos_target: vec2; // where are they reporting the player is?
}

function guardActAll(/* popups: Popups, lines: Lines, */ map: GameMap, player: Player) {

    // Mark if we heard a guard last turn, and clear the speaking flag.

    for (const guard of map.guards) {
        guard.heardGuard = guard.hearingGuard;
        guard.hearingGuard = false;
        guard.speaking = false;
        guard.hasMoved = false;
    }

    // Update each guard for this turn.

    const shouts: Array<Shout> = [];
    for (const guard of map.guards) {
        guard.act(/* popups, lines, */ player, map, shouts);
        guard.hasMoved = true;
    }

    // Process shouts

    for (const shout of shouts) {
        alertNearbyGuards(map, shout);
    }
}

function alertNearbyGuards(map: GameMap, shout: Shout) {
    for (const guard of map.guardsInEarshot(shout.pos_shouter, 25)) {
        if (guard.pos[0] != shout.pos_shouter[0] || guard.pos[1] != shout.pos_shouter[1]) {
            guard.hearingGuard = true;
            vec2.copy(guard.heardGuardPos, shout.pos_shouter);
        }
    }
}

function posNextBest(map: GameMap, distanceField: Float64Grid, posFrom: vec2): vec2 {
    let costBest = Infinity;
    let posBest = posFrom;

    const posMin = vec2.fromValues(Math.max(0, posFrom[0] - 1), Math.max(0, posFrom[1] - 1));
    const posMax = vec2.fromValues(Math.min(map.cells.sizeX, posFrom[0] + 2), Math.min(map.cells.sizeY, posFrom[1] + 2));

    for (let x = posMin[0]; x < posMax[0]; ++x) {
        for (let y = posMin[1]; y < posMax[1]; ++y) {
            const cost = distanceField.get(x, y);
            if (cost == Infinity) {
                continue;
            }

            let pos = vec2.fromValues(x, y);
            if (map.guardMoveCost(posFrom, pos) == Infinity) {
                continue;
            }

            if (map.cells.at(pos[0], pos[1]).type == TerrainType.GroundWater) {
                continue;
            }

            if (map.isGuardAt(pos[0], pos[1])) {
                continue;
            }

            if (cost < costBest) {
                costBest = cost;
                posBest = pos;
            }
        }
    }

    return posBest;
}

function updateDir(dir: vec2, pos: vec2, posTarget: vec2) {
    const dirTarget = vec2.create();
    vec2.subtract(dirTarget, posTarget, pos);

    const dirLeft = vec2.fromValues(-dir[1], dir[0]);

    let dotForward = vec2.dot(dir, dirTarget);
    let dotLeft = vec2.dot(dirLeft, dirTarget);

    if (Math.abs(dotForward) >= Math.abs(dotLeft)) {
        if (dotForward >= 0) {
            // leave dir unchanged
        } else {
            vec2.negate(dir, dir);
        }
    } else if (Math.abs(dotLeft) > Math.abs(dotForward)) {
        if (dotLeft >= 0) {
            vec2.copy(dir, dirLeft);
        } else {
            vec2.negate(dir, dirLeft);
        }
    } else if (dotForward > 0) {
        // leave dir unchanged
    } else if (dotLeft >= 0) {
        vec2.copy(dir, dirLeft);
    } else {
        vec2.negate(dir, dirLeft);
    }
}

function torchNeedingRelighting(map: GameMap, posViewer: vec2): Item | undefined {
    let bestItem = undefined;
    let bestDistSquared = Infinity;
    for (const item of map.items) {
        if (item.type === ItemType.TorchUnlit) {
            const distSquared = vec2.squaredDistance(item.pos, posViewer);
            if (distSquared >= bestDistSquared) {
                continue;
            }
            if (!lineOfSight(map, posViewer, item.pos)) {
                continue;
            }
            bestDistSquared = distSquared;
            bestItem = item;
        }
    }
    return bestItem;
}

function relightTorchAt(map: GameMap, posTorch: vec2) {
    for (const item of map.items) {
        if (item.type === ItemType.TorchUnlit && item.pos[0] === posTorch[0] && item.pos[1] === posTorch[1]) {
            item.type = ItemType.TorchLit;
        }
    }
}

function lineOfSight(map: GameMap, from: vec2, to: vec2): boolean {
    let x = from[0];
    let y = from[1];

    const dx = to[0] - x;
    const dy = to[1] - y;

    let ax = Math.abs(dx);
    let ay = Math.abs(dy);

    const x_inc = (dx > 0) ? 1 : -1;
    const y_inc = (dy > 0) ? 1 : -1;

    let error = ay - ax;

    let n = ax + ay - 1;

    ax *= 2;
    ay *= 2;

    while (n > 0) {
        if (error > 0) {
            y += y_inc;
            error -= ax;
        } else {
            x += x_inc;
            error += ay;
        }

        if (map.cells.at(x, y).blocksSight) {
            return false;
        }

        --n;
    }

    return true;
}

function patrolPathLoops(patrolPath: Array<vec2>): boolean {
    const dx = patrolPath[0][0] - patrolPath[patrolPath.length - 1][0];
    const dy = patrolPath[0][1] - patrolPath[patrolPath.length - 1][1];
    return (dx != 0 || dy != 0) && Math.abs(dx) < 2 && Math.abs(dy) < 2;
}
