# orders-status — Assignment 01 brownfield task (kept so the 01 rubric still runs through the 02 gates)
Problem: Orders in sample/orders-api have no lifecycle; the change must add one without breaking existing clients
Owner: Hamza Rasheed
Metric: standards verdict on sample/orders-api incl. contract-compat, per run   before: ____   after: ____
Scenario: WHEN a new order is created THEN its status is pending
Scenario: WHEN a pending order is PATCHed to paid THEN it answers 200 with the updated order
Scenario: WHEN a shipped order is PATCHed back to pending THEN it answers 409 application/problem+json
Scenario: WHEN an existing client reads an order THEN every field it read before is still present with the same type
Not included: refunds, partial shipments, payment provider integration
Read: ./bin/harness check --api sample/orders-api | grep verdict
Signed: ____
