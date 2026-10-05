import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { CreateOrderBody, Order } from "../schemas/orders.ts";

const orders = new Map<string, Order>();

export function listOrders(customerId?: string): Order[] {
  const all = [...orders.values()];
  return customerId === undefined ? all : all.filter((o) => o.customerId === customerId);
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function createOrder(input: z.infer<typeof CreateOrderBody>): Order {
  const order: Order = {
    id: randomUUID(),
    customerId: input.customerId,
    items: input.items,
    totalCents: input.items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0),
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

export function deleteOrder(id: string): boolean {
  return orders.delete(id);
}

export function resetOrders(): void {
  orders.clear();
}
