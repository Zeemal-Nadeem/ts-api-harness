import { z } from "zod";
import { CursorQuery, pageOf } from "../lib/pagination.ts";

export const OrderItem = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
});

export const OrderStatus = z.enum(["pending", "paid", "shipped", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const Order = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  items: z.array(OrderItem).min(1),
  totalCents: z.number().int().nonnegative(),
  status: OrderStatus,
  createdAt: z.iso.datetime(),
});
export type Order = z.infer<typeof Order>;

export const CreateOrderBody = z.object({
  customerId: z.uuid(),
  items: z.array(OrderItem).min(1),
});

export const OrderParams = z.object({ id: z.uuid() });

export const ListOrdersQuery = CursorQuery.extend({
  customerId: z.uuid().optional(),
  status: OrderStatus.optional(),
});

export const UpdateOrderStatusBody = z.object({
  status: OrderStatus,
});

export const OrderPage = pageOf(Order);
