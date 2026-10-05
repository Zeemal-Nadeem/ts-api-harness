import { Router } from "express";
import { idempotency } from "../lib/idempotency.ts";
import { paginate } from "../lib/pagination.ts";
import { HttpProblem } from "../lib/problem.ts";
import { CreateOrderBody, ListOrdersQuery, Order, OrderPage, OrderParams } from "../schemas/orders.ts";
import { createOrder, deleteOrder, getOrder, listOrders } from "../store/orders.ts";

export const ordersRouter = Router();

ordersRouter.get("/", async (req, res) => {
  const query = ListOrdersQuery.parse(req.query);
  const page = paginate(listOrders(query.customerId), query);
  res.status(200).json(OrderPage.parse(page));
});

ordersRouter.post("/", idempotency, async (req, res) => {
  const body = CreateOrderBody.parse(req.body);
  res.status(201).json(Order.parse(createOrder(body)));
});

ordersRouter.get("/:id", async (req, res) => {
  const { id } = OrderParams.parse(req.params);
  const order = getOrder(id);
  if (order === undefined) throw new HttpProblem(404, "Order not found", `No order with id ${id}`);
  res.status(200).json(Order.parse(order));
});

ordersRouter.delete("/:id", async (req, res) => {
  const { id } = OrderParams.parse(req.params);
  if (!deleteOrder(id)) throw new HttpProblem(404, "Order not found", `No order with id ${id}`);
  res.status(204).end();
});
