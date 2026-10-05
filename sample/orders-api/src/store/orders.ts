import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { CreateOrderBody, Order, OrderStatus } from "../schemas/orders.ts";

const orders = new Map<string, Order>();

export function listOrders(filters: { customerId?: string | undefined; status?: OrderStatus | undefined } = {}): Order[] {
  return [...orders.values()].filter(
    (o) => (filters.customerId === undefined || o.customerId === filters.customerId) && (filters.status === undefined || o.status === filters.status),
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
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  orders.set(order.id, order);
  return order;
}

export function updateOrderStatus(id: string, status: OrderStatus): Order | undefined {
  const order = orders.get(id);
  if (order === undefined) return undefined;
  const updated: Order = { ...order, status };
  orders.set(id, updated);
  return updated;
}

export function deleteOrder(id: string): boolean {
  return orders.delete(id);
}

export function resetOrders(): void {
  orders.clear();
}
