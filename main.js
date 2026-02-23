// ─── Constants ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

const BOARD_SIZE = 24;
const CELL_SIZE = canvas.width / (BOARD_SIZE + 1);
const PEG_RADIUS = 10;

// ─── Color Palette (Canvas drawing) ───────────────────────────────────────
const COLORS = {
    // Board
    boardBg: '#c8a96e',
    boardTexture: 'rgba(0,0,0,0.04)',
    gridDot: 'rgba(100,60,20,0.5)',

    // Border lines
    whiteBorder: '#f5f0e8',
    blackBorder: '#222222',

    // Links
    whiteLink: 'rgba(245,240,232,0.9)',
    blackLink: 'rgba(30,24,20,0.85)',

    // White pegs
    whitePegFill: '#f5f0e8',
    whitePegStroke: '#c8bda0',
    whitePegText: '#3a2510',

    // Black pegs
    blackPegFill: '#1a1410',
    blackPegStroke: '#3a3530',
    blackPegText: '#c8a870',

    // Game over modal
    whiteWinText: '#f5f0e8',
    blackWinText: '#e63946',
};

// Peg number font
const PEG_FONT = 'bold 11px Space Mono, monospace';

// ─── Game State ────────────────────────────────────────────────────────────
let currentPlayer = 1;   // 1=white, 2=black
let pegs = [];
let links = [];
let gameOver = false;
let mctsIterations = 150;
let isAITurn = false;

// ─── Pie Rule State ────────────────────────────────────────────────────────
let gamePhase = 'coin_toss';
let tossWinner = null;   // 'human' | 'ai'
let humanColor = 0;      // 1=white, 2=black
let aiColor = 0;
let firstPegPos = null;
let rotateBoard = false;

// ─── Display coordinate transform ─────────────────────────────────────────
function toScreen(gx, gy) {
    if (rotateBoard) return { sx: gy * CELL_SIZE, sy: gx * CELL_SIZE };
    return { sx: gx * CELL_SIZE, sy: gy * CELL_SIZE };
}

function toGame(screenX, screenY) {
    if (rotateBoard) {
        return { gx: Math.round(screenY / CELL_SIZE), gy: Math.round(screenX / CELL_SIZE) };
    }
    return { gx: Math.round(screenX / CELL_SIZE), gy: Math.round(screenY / CELL_SIZE) };
}

// ─── Geometry helpers ──────────────────────────────────────────────────────
function ccw(A, B, C) {
    return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
}

function intersect(A, B, C, D) {
    if ((A.x === C.x && A.y === C.y) || (A.x === D.x && A.y === D.y) ||
        (B.x === C.x && B.y === C.y) || (B.x === D.x && B.y === D.y)) return false;
    return (ccw(A, C, D) !== ccw(B, C, D)) && (ccw(A, B, C) !== ccw(A, B, D));
}

// ─── AcrossState (for MCTS) ───────────────────────────────────────────────
class AcrossState {
    constructor(pegs, links, player) {
        this.pegs = pegs;
        this.links = links;
        this.player = player;
        this.BS = BOARD_SIZE;
    }

    clone() {
        return new AcrossState(
            this.pegs.map(p => ({ x: p.x, y: p.y, player: p.player })),
            this.links.map(l => ({ p1: { x: l.p1.x, y: l.p1.y }, p2: { x: l.p2.x, y: l.p2.y }, player: l.player })),
            this.player
        );
    }

    getValidMoves() {
        const occupied = new Set(this.pegs.map(p => p.x * 100 + p.y));
        const moves = [];
        const BS = this.BS;
        for (let x = 1; x <= BS; x++) {
            for (let y = 1; y <= BS; y++) {
                if ((x === 1 && y === 1) || (x === 1 && y === BS) || (x === BS && y === 1) || (x === BS && y === BS)) continue;
                if (this.player === 1 && (x === 1 || x === BS)) continue;
                if (this.player === 2 && (y === 1 || y === BS)) continue;
                if (!occupied.has(x * 100 + y)) moves.push({ x, y });
            }
        }
        return moves;
    }

    applyMove(move) {
        const x = move.x, y = move.y;
        const pl = this.player;
        this.pegs.push({ x, y, player: pl });

        for (const p of this.pegs) {
            if (p.x === x && p.y === y) continue;
            if (p.player !== pl) continue;
            const dx = Math.abs(p.x - x), dy = Math.abs(p.y - y);
            if ((dx === 1 && dy === 2) || (dx === 2 && dy === 1)) {
                const lk = { p1: { x, y }, p2: { x: p.x, y: p.y }, player: pl };
                let ok = true;
                for (const el of this.links) {
                    if (intersect(lk.p1, lk.p2, el.p1, el.p2)) { ok = false; break; }
                }
                if (ok) this.links.push(lk);
            }
        }
        this.player = pl === 1 ? 2 : 1;
    }

    checkWin(player) {
        const playerPegs = this.pegs.filter(p => p.player === player);
        if (playerPegs.length === 0) return false;
        const adj = new Map();
        playerPegs.forEach(p => adj.set(p.x * 100 + p.y, []));
        this.links.forEach(l => {
            if (l.player !== player) return;
            const k1 = l.p1.x * 100 + l.p1.y, k2 = l.p2.x * 100 + l.p2.y;
            if (adj.has(k1) && adj.has(k2)) {
                adj.get(k1).push(l.p2);
                adj.get(k2).push(l.p1);
            }
        });
        let starts, goal;
        if (player === 1) {
            starts = playerPegs.filter(p => p.y === 1);
            goal = p => p.y === this.BS;
        } else {
            starts = playerPegs.filter(p => p.x === 1);
            goal = p => p.x === this.BS;
        }
        const visited = new Set();
        const queue = [...starts];
        starts.forEach(p => visited.add(p.x * 100 + p.y));
        while (queue.length > 0) {
            const cur = queue.shift();
            if (goal(cur)) return true;
            for (const nb of (adj.get(cur.x * 100 + cur.y) || [])) {
                const k = nb.x * 100 + nb.y;
                if (!visited.has(k)) { visited.add(k); queue.push(nb); }
            }
        }
        return false;
    }

    isTerminal() { return this.checkWin(1) || this.checkWin(2); }

    getWinner() {
        if (this.checkWin(1)) return 1;
        if (this.checkWin(2)) return 2;
        return 0;
    }
}

// ─── MCTS ──────────────────────────────────────────────────────────────────
class MCTSNode {
    constructor(state, parent = null, move = null) {
        this.state = state;
        this.parent = parent;
        this.move = move;
        this.children = [];
        this.wins = 0;
        this.visits = 0;
        this.untriedMoves = null;
    }

    getUntriedMoves() {
        if (this.untriedMoves === null) this.untriedMoves = this.state.getValidMoves();
        return this.untriedMoves;
    }

    uct(c = 1.414) {
        if (this.visits === 0) return Infinity;
        return this.wins / this.visits + c * Math.sqrt(Math.log(this.parent.visits) / this.visits);
    }

    bestChild() { return this.children.reduce((a, b) => b.uct() > a.uct() ? b : a); }
    mostVisitedChild() { return this.children.reduce((a, b) => b.visits > a.visits ? b : a); }
}

function mctsSearch(rootState, iterations, aiPlayerColor) {
    const root = new MCTSNode(rootState.clone());

    for (let i = 0; i < iterations; i++) {
        let node = root;
        while (node.getUntriedMoves().length === 0 && node.children.length > 0) node = node.bestChild();

        const untried = node.getUntriedMoves();
        if (untried.length > 0) {
            const move = selectMoveWithHeuristic(untried, node.state);
            untried.splice(untried.indexOf(move), 1);
            const childState = node.state.clone();
            childState.applyMove(move);
            const child = new MCTSNode(childState, node, move);
            node.children.push(child);
            node = child;
        }

        let simState = node.state.clone();
        let depth = 0;
        while (!simState.isTerminal() && depth < 60) {
            const moves = simState.getValidMoves();
            if (moves.length === 0) break;
            const move = Math.random() < 0.3
                ? selectMoveWithHeuristic(moves, simState)
                : moves[Math.floor(Math.random() * moves.length)];
            simState.applyMove(move);
            depth++;
        }

        const winner = simState.getWinner();
        let cur = node;
        while (cur !== null) {
            cur.visits++;
            if (winner === aiPlayerColor) cur.wins++;
            else if (winner !== 0) cur.wins--;
            cur = cur.parent;
        }
    }

    if (root.children.length === 0) {
        const moves = rootState.getValidMoves();
        return moves.length > 0 ? moves[Math.floor(Math.random() * moves.length)] : null;
    }
    return root.mostVisitedChild().move;
}

function selectMoveWithHeuristic(moves, state) {
    const BS = BOARD_SIZE;
    const cx = (BS + 1) / 2, cy = (BS + 1) / 2;
    const pl = state.player;
    const playerPegs = state.pegs.filter(p => p.player === pl);

    let best = null, bestScore = -Infinity;
    const sample = moves.length > 20 ? shuffle(moves).slice(0, 20) : moves;

    for (const m of sample) {
        let score = 0;
        score -= (Math.abs(m.x - cx) + Math.abs(m.y - cy)) * 0.5;
        if (pl === 2) score += m.x * 0.3;
        else score -= Math.abs(m.y - cy) * 0.3;
        for (const p of playerPegs) {
            const dx = Math.abs(p.x - m.x), dy = Math.abs(p.y - m.y);
            if ((dx === 1 && dy === 2) || (dx === 2 && dy === 1)) score += 2;
        }
        if (score > bestScore) { bestScore = score; best = m; }
    }
    return best || moves[Math.floor(Math.random() * moves.length)];
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ─── Drawing ───────────────────────────────────────────────────────────────
function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLORS.boardBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Texture
    ctx.fillStyle = COLORS.boardTexture;
    for (let i = 1; i <= BOARD_SIZE; i++) {
        for (let j = 1; j <= BOARD_SIZE; j++) {
            if ((i + j) % 2 === 0) {
                const s = toScreen(i, j);
                ctx.fillRect(s.sx - CELL_SIZE / 2, s.sy - CELL_SIZE / 2, CELL_SIZE, CELL_SIZE);
            }
        }
    }

    // Grid dots
    for (let i = 1; i <= BOARD_SIZE; i++) {
        for (let j = 1; j <= BOARD_SIZE; j++) {
            if ((i === 1 && j === 1) || (i === 1 && j === BOARD_SIZE) || (i === BOARD_SIZE && j === 1) || (i === BOARD_SIZE && j === BOARD_SIZE)) continue;
            const s = toScreen(i, j);
            ctx.beginPath();
            ctx.arc(s.sx, s.sy, 2, 0, Math.PI * 2);
            ctx.fillStyle = COLORS.gridDot;
            ctx.fill();
        }
    }

    // Border lines
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';

    // White borders (game y=1 and y=BS)
    const wt1 = toScreen(1.5, 1);
    const wt2 = toScreen(BOARD_SIZE - 0.5, 1);
    const wb1 = toScreen(1.5, BOARD_SIZE);
    const wb2 = toScreen(BOARD_SIZE - 0.5, BOARD_SIZE);
    ctx.strokeStyle = COLORS.whiteBorder;
    ctx.beginPath();
    ctx.moveTo(wt1.sx, wt1.sy); ctx.lineTo(wt2.sx, wt2.sy);
    ctx.moveTo(wb1.sx, wb1.sy); ctx.lineTo(wb2.sx, wb2.sy);
    ctx.stroke();

    // Black borders (game x=1 and x=BS)
    const bl1 = toScreen(1, 1.5);
    const bl2 = toScreen(1, BOARD_SIZE - 0.5);
    const br1 = toScreen(BOARD_SIZE, 1.5);
    const br2 = toScreen(BOARD_SIZE, BOARD_SIZE - 0.5);
    ctx.strokeStyle = COLORS.blackBorder;
    ctx.beginPath();
    ctx.moveTo(bl1.sx, bl1.sy); ctx.lineTo(bl2.sx, bl2.sy);
    ctx.moveTo(br1.sx, br1.sy); ctx.lineTo(br2.sx, br2.sy);
    ctx.stroke();

    // Links
    links.forEach(link => {
        const s1 = toScreen(link.p1.x, link.p1.y);
        const s2 = toScreen(link.p2.x, link.p2.y);
        ctx.beginPath();
        ctx.moveTo(s1.sx, s1.sy);
        ctx.lineTo(s2.sx, s2.sy);
        ctx.strokeStyle = link.player === 1 ? COLORS.whiteLink : COLORS.blackLink;
        ctx.lineWidth = 4;
        ctx.stroke();
    });

    // Pegs
    pegs.forEach(peg => {
        const s = toScreen(peg.x, peg.y);
        const isWhite = peg.player === 1;

        ctx.beginPath();
        ctx.arc(s.sx, s.sy, PEG_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = isWhite ? COLORS.whitePegFill : COLORS.blackPegFill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isWhite ? COLORS.whitePegStroke : COLORS.blackPegStroke;
        ctx.stroke();

        ctx.fillStyle = isWhite ? COLORS.whitePegText : COLORS.blackPegText;
        ctx.font = PEG_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(peg.number, s.sx, s.sy);
    });
}

function drawNeutralPeg(gx, gy) {
    const s = toScreen(gx, gy);
    ctx.beginPath();
    ctx.arc(s.sx, s.sy, PEG_RADIUS + 2, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.whitePegFill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.whitePegStroke;
    ctx.stroke();
    ctx.fillStyle = COLORS.whitePegText;
    ctx.font = PEG_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('1', s.sx, s.sy);
}

// ─── Win check ────────────────────────────────────────────────────────────
function checkWin(player) {
    return new AcrossState(pegs, links, player).checkWin(player);
}

// ─── UI updates ───────────────────────────────────────────────────────────
function updateStats() {
    document.getElementById('stat-moves').textContent = pegs.length;
    document.getElementById('stat-white').textContent = pegs.filter(p => p.player === 1).length;
    document.getElementById('stat-black').textContent = pegs.filter(p => p.player === 2).length;
    document.getElementById('stat-links').textContent = links.length;
}

function updateTurnDisplay(thinking = false) {
    const el = document.getElementById('turn-display');
    const card1 = document.getElementById('card-human');
    const card2 = document.getElementById('card-ai');

    if (gamePhase !== 'playing') {
        el.textContent = 'SETUP';
        el.className = 'turn-value setup';
        card1.classList.remove('active');
        card2.classList.remove('active');
        return;
    }

    if (thinking) {
        el.textContent = 'THINKING';
        el.className = 'turn-value thinking';
        card1.classList.remove('active');
        card2.classList.add('active');
    } else if (currentPlayer === humanColor) {
        el.textContent = humanColor === 1 ? 'WHITE' : 'BLACK';
        el.className = humanColor === 1 ? 'turn-value white' : 'turn-value black';
        card1.classList.add('active');
        card2.classList.remove('active');
    } else {
        el.textContent = aiColor === 1 ? 'WHITE' : 'BLACK';
        el.className = aiColor === 1 ? 'turn-value white' : 'turn-value black';
        card1.classList.remove('active');
        card2.classList.add('active');
    }
}

function updatePlayerCards() {
    const roleHuman = document.getElementById('role-human');
    const roleAI = document.getElementById('role-ai');
    const goalHuman = document.getElementById('goal-human');
    const goalAI = document.getElementById('goal-ai');

    if (humanColor === 0) {
        roleHuman.innerHTML = '<span class="status-dot dot-white"></span>HUMAN';
        roleHuman.className = 'player-role human';
        roleAI.innerHTML = '<span class="status-dot dot-black"></span>AI';
        roleAI.className = 'player-role ai';
        goalHuman.textContent = 'Goal: —';
        goalAI.textContent = 'Goal: —';
    } else {
        const hDot = humanColor === 1 ? 'dot-white' : 'dot-black';
        const aDot = aiColor === 1 ? 'dot-white' : 'dot-black';
        const hLabel = humanColor === 1 ? 'WHITE' : 'BLACK';
        const aLabel = aiColor === 1 ? 'WHITE' : 'BLACK';
        roleHuman.innerHTML = `<span class="status-dot ${hDot}"></span>HUMAN (${hLabel})`;
        roleHuman.className = 'player-role human';
        roleAI.innerHTML = `<span class="status-dot ${aDot}"></span>AI (${aLabel})`;
        roleAI.className = 'player-role ai';
        goalHuman.textContent = 'Goal: Top → Bottom';
        goalAI.textContent = 'Goal: Left → Right';
    }
}

function setPhaseIndicator(text) {
    const el = document.getElementById('phase-indicator');
    if (text) { el.textContent = text; el.classList.remove('hidden'); }
    else { el.classList.add('hidden'); }
}

function showThinking(show, text) {
    document.getElementById('thinking-text').textContent = text || 'AI THINKING...';
    document.getElementById('thinking-overlay').classList.toggle('active', show);
}

function showGameOver(winner) {
    const modal = document.getElementById('modal-gameover');
    const winnerEl = document.getElementById('modal-winner');
    const subEl = document.getElementById('modal-sub');
    const isHumanWin = winner === humanColor;
    if (winner === 1) {
        winnerEl.textContent = 'WHITE WINS';
        winnerEl.style.color = COLORS.whiteWinText;
    } else {
        winnerEl.textContent = 'BLACK WINS';
        winnerEl.style.color = COLORS.blackWinText;
    }
    subEl.textContent = isHumanWin ? 'You win! Connected top to bottom.' : 'AI wins! Connected left to right.';
    modal.classList.add('active');
}

// ─── Coin Toss ────────────────────────────────────────────────────────────
function flipCoin() {
    const coin = document.getElementById('coin');
    const resultEl = document.getElementById('coin-result');
    const flipBtn = document.getElementById('coin-flip-btn');
    const okBtn = document.getElementById('coin-ok-btn');

    flipBtn.disabled = true;
    flipBtn.style.opacity = 0.3;

    const humanWins = Math.random() < 0.5;
    tossWinner = humanWins ? 'human' : 'ai';

    coin.classList.remove('flipping', 'result-tails');
    void coin.offsetWidth;

    if (humanWins) coin.classList.add('flipping');
    else coin.classList.add('flipping', 'result-tails');

    resultEl.textContent = '...';
    resultEl.style.color = 'var(--gold)';

    setTimeout(() => {
        resultEl.textContent = humanWins ? 'YOU WIN!' : 'AI WINS!';
        resultEl.style.color = humanWins ? 'var(--white-peg)' : 'var(--accent-r)';
        flipBtn.classList.add('hidden');
        okBtn.classList.remove('hidden');
    }, 2200);
}

function afterCoinToss() {
    document.getElementById('modal-coin').classList.remove('active');
    gamePhase = 'first_peg';

    if (tossWinner === 'human') {
        setPhaseIndicator('PLACE FIRST PEG (WHITE)');
        updateTurnDisplay();
    } else {
        setPhaseIndicator('AI PLACING FIRST PEG...');
        updateTurnDisplay();
        setTimeout(() => aiPlaceFirstPeg(), 500);
    }
}

// ─── First Peg (always white) ─────────────────────────────────────────────
function aiPlaceFirstPeg() {
    showThinking(true, 'AI PLACING...');
    setTimeout(() => {
        const BS = BOARD_SIZE;
        const cx = Math.round((BS + 1) / 2);
        const cy = Math.round((BS + 1) / 2);
        const ox = Math.floor(Math.random() * 5) - 2;
        const oy = Math.floor(Math.random() * 5) - 2;
        const x = Math.max(2, Math.min(BS - 1, cx + ox));
        const y = Math.max(2, Math.min(BS - 1, cy + oy));
        firstPegPos = { x, y };

        drawBoard();
        drawNeutralPeg(x, y);
        showThinking(false);

        gamePhase = 'color_choice';
        setPhaseIndicator('CHOOSE YOUR COLOR');
        updateTurnDisplay();

        document.getElementById('color-modal-desc').textContent =
            `AI placed the first white peg at (${x}, ${y}). Choose your color.`;
        setTimeout(() => document.getElementById('modal-color').classList.add('active'), 600);
    }, 800);
}

// ─── Color Choice ─────────────────────────────────────────────────────────
function humanChooseColor(color) {
    document.getElementById('modal-color').classList.remove('active');
    humanColor = color;
    aiColor = color === 1 ? 2 : 1;
    rotateBoard = (humanColor === 2);

    pegs.push({ x: firstPegPos.x, y: firstPegPos.y, player: 1, number: 1 });

    updatePlayerCards();
    startPlaying();
}

function aiChooseColor() {
    aiColor = Math.random() < 0.5 ? 1 : 2;
    humanColor = aiColor === 1 ? 2 : 1;
    rotateBoard = (humanColor === 2);

    pegs.push({ x: firstPegPos.x, y: firstPegPos.y, player: 1, number: 1 });

    updatePlayerCards();

    showThinking(true, `AI CHOSE ${aiColor === 1 ? 'WHITE' : 'BLACK'}`);
    setTimeout(() => {
        showThinking(false);
        startPlaying();
    }, 1200);
}

// ─── Start Playing ────────────────────────────────────────────────────────
function startPlaying() {
    gamePhase = 'playing';
    setPhaseIndicator(null);

    currentPlayer = 2;

    drawBoard();
    updateStats();
    updateTurnDisplay();

    if (aiColor === currentPlayer) doAIMove();
}

// ─── Place Peg ────────────────────────────────────────────────────────────
function placePeg(x, y, player) {
    const newPeg = { x, y, player, number: pegs.length + 1 };
    pegs.push(newPeg);

    pegs.forEach(p => {
        if (p === newPeg) return;
        if (p.player !== player) return;
        const dx = Math.abs(p.x - x), dy = Math.abs(p.y - y);
        if ((dx === 1 && dy === 2) || (dx === 2 && dy === 1)) {
            const lk = { p1: { x, y }, p2: { x: p.x, y: p.y }, player };
            let ok = true;
            for (const el of links) {
                if (intersect(lk.p1, lk.p2, el.p1, el.p2)) { ok = false; break; }
            }
            if (ok) links.push(lk);
        }
    });
}

// ─── AI Move ──────────────────────────────────────────────────────────────
function doAIMove() {
    isAITurn = true;
    showThinking(true);
    updateTurnDisplay(true);

    setTimeout(() => {
        const state = new AcrossState(
            pegs.map(p => ({ x: p.x, y: p.y, player: p.player })),
            links.map(l => ({ p1: { x: l.p1.x, y: l.p1.y }, p2: { x: l.p2.x, y: l.p2.y }, player: l.player })),
            aiColor
        );

        const move = mctsSearch(state, mctsIterations, aiColor);
        if (move) {
            placePeg(move.x, move.y, aiColor);
            drawBoard();
            updateStats();

            if (checkWin(aiColor)) {
                gameOver = true;
                showThinking(false);
                drawBoard();
                setTimeout(() => showGameOver(aiColor), 300);
                return;
            }
        }

        currentPlayer = humanColor;
        isAITurn = false;
        showThinking(false);
        updateTurnDisplay();
        drawBoard();
    }, 20);
}

// ─── Human Click ──────────────────────────────────────────────────────────
canvas.addEventListener('click', (e) => {
    if (gameOver || isAITurn) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const screenX = (e.clientX - rect.left) * scaleX;
    const screenY = (e.clientY - rect.top) * scaleY;

    // First peg phase: no rotation yet
    if (gamePhase === 'first_peg' && tossWinner === 'human') {
        const x = Math.round(screenX / CELL_SIZE);
        const y = Math.round(screenY / CELL_SIZE);
        if (x < 2 || x > BOARD_SIZE - 1 || y < 2 || y > BOARD_SIZE - 1) return;
        if (pegs.some(p => p.x === x && p.y === y)) return;

        firstPegPos = { x, y };
        drawBoard();
        drawNeutralPeg(x, y);

        gamePhase = 'color_choice';
        setPhaseIndicator('AI CHOOSING COLOR...');
        updateTurnDisplay();
        setTimeout(() => aiChooseColor(), 800);
        return;
    }

    // Normal play: use coordinate transform
    if (gamePhase !== 'playing') return;
    if (currentPlayer !== humanColor) return;

    const { gx, gy } = toGame(screenX, screenY);
    const x = gx, y = gy;

    if (x < 1 || x > BOARD_SIZE || y < 1 || y > BOARD_SIZE) return;
    if ((x === 1 && y === 1) || (x === 1 && y === BOARD_SIZE) || (x === BOARD_SIZE && y === 1) || (x === BOARD_SIZE && y === BOARD_SIZE)) return;
    if (humanColor === 1 && (x === 1 || x === BOARD_SIZE)) return;
    if (humanColor === 2 && (y === 1 || y === BOARD_SIZE)) return;
    if (pegs.some(p => p.x === x && p.y === y)) return;

    placePeg(x, y, humanColor);
    drawBoard();
    updateStats();

    if (checkWin(humanColor)) {
        gameOver = true;
        setTimeout(() => showGameOver(humanColor), 300);
        return;
    }

    currentPlayer = aiColor;
    doAIMove();
});

// ─── Difficulty ────────────────────────────────────────────────────────────
function setDifficulty(btn) {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mctsIterations = parseInt(btn.dataset.iter);
}

// ─── Export PNG ───────────────────────────────────────────────────────────
function getTimestamp() {
    const now = new Date();
    const d = String(now.getFullYear()) +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0');
    const t = String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
    return { d, t };
}

function exportBoard() {
    drawBoard();
    const { d, t } = getTimestamp();
    const filename = gameOver
        ? `across_endgame_${d}_${t}.png`
        : `across_move${pegs.length}_${d}_${t}.png`;
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

// ─── Close Game Over Modal ────────────────────────────────────────────────
function closeGameOverModal() {
    document.getElementById('modal-gameover').classList.remove('active');
}

// ─── Reset ─────────────────────────────────────────────────────────────────
function resetGame() {
    pegs = []; links = [];
    currentPlayer = 1;
    gameOver = false; isAITurn = false;
    gamePhase = 'coin_toss';
    tossWinner = null;
    humanColor = 0; aiColor = 0;
    firstPegPos = null;
    rotateBoard = false;

    document.getElementById('modal-gameover').classList.remove('active');
    document.getElementById('modal-color').classList.remove('active');
    showThinking(false);
    updatePlayerCards();
    setPhaseIndicator('COIN TOSS');
    updateTurnDisplay();
    updateStats();
    drawBoard();

    const coin = document.getElementById('coin');
    coin.classList.remove('flipping', 'result-tails');
    document.getElementById('coin-result').textContent = '—';
    document.getElementById('coin-flip-btn').classList.remove('hidden');
    document.getElementById('coin-flip-btn').disabled = false;
    document.getElementById('coin-flip-btn').style.opacity = 1;
    document.getElementById('coin-ok-btn').classList.add('hidden');

    setTimeout(() => document.getElementById('modal-coin').classList.add('active'), 300);
}

// ─── Init ──────────────────────────────────────────────────────────────────
updatePlayerCards();
setPhaseIndicator('COIN TOSS');
updateTurnDisplay();
drawBoard();
setTimeout(() => document.getElementById('modal-coin').classList.add('active'), 500);