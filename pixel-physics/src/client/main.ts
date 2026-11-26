import { PhysicsEngine } from '../engine/PhysicsEngine.ts';
import { registerDefaultPlugins } from '../plugins/index.ts';
import { HudController } from './HudController.ts';
import { InputController } from './InputController.ts';
import { PixelPhysicsRenderer } from './Renderer.ts';

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('sim-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('Missing #sim-canvas element');

  const engine = new PhysicsEngine({
    width: window.innerWidth,
    height: window.innerHeight,
    groundHeight: 28,
    virtualPixelSize: 8,
  });

  registerDefaultPlugins(engine);

  const renderer = new PixelPhysicsRenderer(canvas, engine);
  await renderer.init();

  let running = true;
  let rafId = 0;
  let lastTime = performance.now();

  let input!: InputController;
  const hud = new HudController(engine, {
    onExit: () => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      input.setActive(false);

      // Attempt to close the browser window/tab without stopping the Bun server
      window.close();

      // If the browser blocks closing a user-opened tab, show a clean CRT halted screen
      window.setTimeout(() => {
        if (!window.closed) {
          hud.showExitOverlay();
        }
      }, 120);
    },
    onResume: () => {
      if (running) return;
      running = true;
      input.setActive(true);
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    },
  });

  input = new InputController(canvas, engine, () => {
    hud.syncActiveStates();
  });

  const handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    engine.resize(w, h);
    renderer.resize(w, h);
  };
  window.addEventListener('resize', handleResize);

  const loop = (now: number): void => {
    if (!running) return;
    const deltaMs = Math.max(0.1, now - lastTime);
    lastTime = now;
    const dt = deltaMs / 1000;

    engine.step(dt);

    const solver = engine.getActiveSolver();
    renderer.updateReticle({
      visible: input.pointer.visible,
      worldX: input.pointer.worldX,
      worldY: input.pointer.worldY,
      snapToGrid: solver?.snapVisualsToGrid ?? false,
    });

    renderer.render(dt);
    hud.updateCounters(deltaMs);

    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
}

bootstrap().catch((err) => {
  console.error('Failed to initialize Pixel Physics:', err);
});
