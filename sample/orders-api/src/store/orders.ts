import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { CreateOrderBody, Order, OrderStatus } from "../schemas/orders.ts";

const orders = new Map<string, Order>();

export function listOrders(customerId?: string, status?: OrderStatus): Order[] {
  return [...orders.values()].filter(
    (o) => (customerId === undefined || o.customerId === customerId) && (status === undefined || o.status === status),
  );
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
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function setOrderStatus(id: string, status: OrderStatus): Order | undefined {
  const existing = orders.get(id);
  if (existing === undefined) return undefined;
  const updated: Order = { ...existing, status };
  orders.set(id, updated);
  return updated;
}

export function deleteOrder(id: string): boolean {
  return orders.delete(id);
}

export function resetOrders(): void {
  orders.clear();
}
