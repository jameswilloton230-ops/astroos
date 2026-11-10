(function () {
  'use strict';

  const directions = Object.freeze({
    ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
  });

  function launchSnakeGame() {
    if (document.getElementById('snake-game-overlay')) return;

    const COLS = 20, ROWS = 20, CELL = 18;
    const W = COLS * CELL, H = ROWS * CELL;

    const overlay = createEl('div', {
      id: 'snake-game-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:99999;'
    });
    const win = createEl('div', {
      style: 'background:rgba(10,14,22,0.96);border:1px solid rgba(255,255,255,0.18);border-radius:16px;box-shadow:0 32px 64px rgba(0,0,0,0.6);overflow:hidden;user-select:none;'
    });

    const titleBar = createEl('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.08);'
    });
    const titleText = createEl('span', {
      textContent: '🐍 NovaByte Snake',
      style: 'font-size:13px;font-weight:600;color:var(--text-primary);'
    });
    const closeBtn = createEl('button', {
      textContent: '✕',
      'aria-label': 'Close',
      style: 'background:rgba(248,81,73,0.18);border:1px solid rgba(248,81,73,0.35);color:#f85149;border-radius:6px;width:24px;height:24px;font-size:11px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center;'
    });
    titleBar.append(titleText, closeBtn);

    const scoreBar = createEl('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:rgba(0,0,0,0.2);font-size:12px;color:var(--text-secondary);'
    });
    const scoreLabel = createEl('span', { textContent: 'Score: 0' });
    const hintLabel = createEl('span', { textContent: 'Arrow keys / WASD', style: 'color:var(--text-muted);font-size:11px;' });
    scoreBar.append(scoreLabel, hintLabel);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.style.display = 'block';
    canvas.setAttribute('aria-label', 'Snake game canvas');
    const ctx = canvas.getContext('2d');

    win.append(titleBar, scoreBar, canvas);
    overlay.appendChild(win);
    document.body.appendChild(overlay);

    let snake, dir, nextDir, food, score, gameLoop;
    const rand = n => Math.floor(Math.random() * n);

    function spawnFood() {
      let pos;
      do { pos = { x: rand(COLS), y: rand(ROWS) }; }
      while (snake.some(segment => segment.x === pos.x && segment.y === pos.y));
      return pos;
    }

    function init() {
      const mid = { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
      snake = [mid, { x: mid.x - 1, y: mid.y }, { x: mid.x - 2, y: mid.y }];
      dir = { x: 1, y: 0 };
      nextDir = { x: 1, y: 0 };
      food = spawnFood();
      score = 0;
      scoreLabel.textContent = 'Score: 0';
      canvas.parentElement?.querySelector('.snake-game-over')?.remove();
    }

    function draw() {
      ctx.fillStyle = '#07090f';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 0.5;
      for (let column = 0; column <= COLS; column++) {
        ctx.beginPath(); ctx.moveTo(column * CELL, 0); ctx.lineTo(column * CELL, H); ctx.stroke();
      }
      for (let row = 0; row <= ROWS; row++) {
        ctx.beginPath(); ctx.moveTo(0, row * CELL); ctx.lineTo(W, row * CELL); ctx.stroke();
      }

      const fx = food.x * CELL + CELL / 2;
      const fy = food.y * CELL + CELL / 2;
      const fr = CELL / 2 - 2;
      const foodGrad = ctx.createRadialGradient(fx - 2, fy - 2, 1, fx, fy, fr);
      foodGrad.addColorStop(0, '#ff6e6e');
      foodGrad.addColorStop(1, '#f85149');
      ctx.fillStyle = foodGrad;
      ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();

      snake.forEach((segment, index) => {
        const x = segment.x * CELL + 1, y = segment.y * CELL + 1, size = CELL - 2;
        const ratio = index / (snake.length - 1 || 1);
        const red = Math.round(88 + (63 - 88) * ratio);
        const green = Math.round(166 + (190 - 166) * ratio);
        const blue = Math.round(255 + (90 - 255) * ratio);
        ctx.fillStyle = index === 0 ? '#79b8ff' : `rgb(${red},${green},${blue})`;
        ctx.beginPath(); ctx.roundRect(x, y, size, size, index === 0 ? 5 : 3); ctx.fill();
        if (index === 0) {
          ctx.fillStyle = '#07090f';
          const eyeX = x + (dir.x >= 0 ? size - 4 : 3);
          const eyeY = y + (dir.y >= 0 ? 3 : size - 4);
          ctx.beginPath(); ctx.arc(eyeX, eyeY, 2, 0, Math.PI * 2); ctx.fill();
        }
      });
    }

    function gameOver() {
      if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
      const gameOverElement = createEl('div', { className: 'snake-game-over' });
      const title = createEl('div', { className: 'snake-game-over-title', textContent: 'Game Over' });
      const finalScore = createEl('div', { className: 'snake-game-over-score', textContent: `Score: ${score}` });
      const restart = createEl('button', { className: 'snake-restart-btn', textContent: '↺ Play Again' });
      restart.addEventListener('click', () => { gameOverElement.remove(); startGame(); });
      gameOverElement.append(title, finalScore, restart);
      const wrap = canvas.parentElement;
      if (wrap) { wrap.style.position = 'relative'; wrap.appendChild(gameOverElement); }
    }

    function step() {
      dir = { ...nextDir };
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS
        || snake.some(segment => segment.x === head.x && segment.y === head.y)) {
        gameOver();
        return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score++;
        scoreLabel.textContent = `Score: ${score}`;
        food = spawnFood();
      } else {
        snake.pop();
      }
      draw();
    }

    function startGame() {
      if (gameLoop) clearInterval(gameLoop);
      init();
      draw();
      gameLoop = setInterval(step, 120);
    }

    function onKey(event) {
      const next = directions[event.key];
      if (next && !(next.x === -dir.x && next.y === -dir.y)) {
        event.preventDefault();
        nextDir = next;
      }
    }

    document.addEventListener('keydown', onKey);
    const cleanup = () => {
      if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
      document.removeEventListener('keydown', onKey);
    };
    closeBtn.addEventListener('click', () => { cleanup(); overlay.remove(); });
    overlay.addEventListener('click', event => {
      if (event.target === overlay) { cleanup(); overlay.remove(); }
    });

    startGame();
  }

  window.NovaByteEasterEgg = Object.freeze({ launch: launchSnakeGame });
})();
