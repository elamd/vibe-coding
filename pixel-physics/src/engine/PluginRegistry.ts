import type {
  ForcePlugin,
  InteractionPlugin,
  IPluginRegistry,
  PluginCategory,
  PluginContext,
  PluginObject,
  PropertyPlugin,
  SceneObjectPlugin,
  ShapePlugin,
  SolverPlugin,
} from './types.ts';

export class PluginRegistry implements IPluginRegistry {
  private readonly plugins = new Map<string, PluginObject>();
  private readonly contextProvider: () => PluginContext;

  constructor(contextProvider: () => PluginContext) {
    this.contextProvider = contextProvider;
  }

  register<T extends PluginObject>(plugin: T): T {
    if (this.plugins.has(plugin.id)) {
      this.unregister(plugin.id);
    }

    this.plugins.set(plugin.id, plugin);

    const ctx = this.contextProvider();
    if (plugin.category === 'property') {
      const prop = plugin as unknown as PropertyPlugin;
      ctx.store.registerChannel(prop.id, prop.defaultValue);
    }

    plugin.onRegister?.(ctx);
    return plugin;
  }

  unregister(id: string): boolean {
    const existing = this.plugins.get(id);
    if (!existing) return false;
    existing.onUnregister?.(this.contextProvider());
    this.plugins.delete(id);
    return true;
  }

  get<T extends PluginObject = PluginObject>(id: string): T | undefined {
    return this.plugins.get(id) as T | undefined;
  }

  getAll(): PluginObject[] {
    return Array.from(this.plugins.values());
  }

  getByCategory<T extends PluginObject>(category: PluginCategory): T[] {
    const out: T[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.category === category) {
        out.push(plugin as T);
      }
    }
    return out;
  }

  getProperties(): PropertyPlugin[] {
    return this.getByCategory<PropertyPlugin>('property');
  }

  getForces(): ForcePlugin[] {
    return this.getByCategory<ForcePlugin>('force');
  }

  getInteractions(): InteractionPlugin[] {
    return this.getByCategory<InteractionPlugin>('interaction');
  }

  getSolvers(): SolverPlugin[] {
    return this.getByCategory<SolverPlugin>('solver');
  }

  getShapes(): ShapePlugin[] {
    return this.getByCategory<ShapePlugin>('shape');
  }

  getSceneObjects(): SceneObjectPlugin[] {
    return this.getByCategory<SceneObjectPlugin>('scene-object');
  }
}
