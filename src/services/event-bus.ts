import { randomUUID } from "node:crypto";
import type { DomainEvent } from "../domain/types.js";

type Listener = (event: DomainEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  publish<T extends Record<string, unknown>>(event: Omit<DomainEvent<T>, "id" | "occurredAt">): DomainEvent<T> {
    const complete = { ...event, id: randomUUID(), occurredAt: new Date().toISOString() } as DomainEvent<T>;
    for (const listener of this.listeners) listener(complete);
    return complete;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
