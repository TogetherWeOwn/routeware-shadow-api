export type CustomerBundle = {
  customer: Record<string, unknown> | null;
  addresses: Array<Record<string, unknown> & { containers: Record<string, unknown>[] }>;
};

export type AddressBundle = {
  address: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
  containers: Record<string, unknown>[];
};

export type ContainerBundle = {
  container: Record<string, unknown> | null;
  address: Record<string, unknown> | null;
  customer: Record<string, unknown> | null;
};

function rowToObj(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    o[k] = v;
  }
  return o;
}

export async function getCustomerBundleFromD1(
  db: D1Database,
  customerId: number
): Promise<CustomerBundle | null> {
  const customer = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
            name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
     FROM customer_snapshot WHERE customer_id = ?`
    )
    .bind(customerId)
    .first<Record<string, unknown>>();
  if (!customer) {
    return null;
  }
  const addrRes = await db
    .prepare(
      `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
              extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
       FROM address_snapshot WHERE customer_id = ? ORDER BY pickup_address_id`
    )
    .bind(customerId)
    .all<Record<string, unknown>>();
  const rows = addrRes.results ?? [];
  const addressIds = rows.map((a) => a.pickup_address_id as number);

  // Fetch all containers for this customer's addresses in batched IN(...) queries
  // (chunked to stay under D1's 100-bind cap) instead of one query per address.
  const containersByAddress = new Map<number, Record<string, unknown>[]>();
  const BIND_CHUNK = 100;
  for (let i = 0; i < addressIds.length; i += BIND_CHUNK) {
    const chunk = addressIds.slice(i, i + BIND_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const cr = await db
      .prepare(
        `SELECT container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, event_code, gps_locked,
                latitude, longitude, enabled, location_address, city, state, zip, container_note, ud_cost_share_ud,
                ud_enclosure_doors_ud, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud,
                ud_material_stream_ud, color, service_code_type, service_code_input, service_code, service_date,
                route_ids, frequency_ids, synced_at
         FROM container_snapshot WHERE pickup_address_id IN (${placeholders}) ORDER BY pickup_address_id, container_id`
      )
      .bind(...chunk)
      .all<Record<string, unknown>>();
    for (const con of cr.results ?? []) {
      const paid = con.pickup_address_id as number;
      const list = containersByAddress.get(paid);
      if (list) {
        list.push(con);
      } else {
        containersByAddress.set(paid, [con]);
      }
    }
  }

  const out: CustomerBundle = {
    customer: rowToObj(customer),
    addresses: rows.map((a) => ({
      ...a,
      containers: containersByAddress.get(a.pickup_address_id as number) ?? []
    }))
  };
  return out;
}

export async function getAddressBundleFromD1(
  db: D1Database,
  pickupAddressId: number
): Promise<AddressBundle | null> {
  const address = await db
    .prepare(
      `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
              extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
       FROM address_snapshot WHERE pickup_address_id = ?`
    )
    .bind(pickupAddressId)
    .first<Record<string, unknown>>();
  if (!address) {
    return null;
  }
  const customerId = address.customer_id as number;
  const customer = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
            name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
     FROM customer_snapshot WHERE customer_id = ?`
    )
    .bind(customerId)
    .first<Record<string, unknown>>();
  const cr = await db
    .prepare(
      `SELECT container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, event_code, gps_locked,
              latitude, longitude, enabled, location_address, city, state, zip, container_note, ud_cost_share_ud,
              ud_enclosure_doors_ud, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud,
              ud_material_stream_ud, color, service_code_type, service_code_input, service_code, service_date,
              route_ids, frequency_ids, synced_at
       FROM container_snapshot WHERE pickup_address_id = ? ORDER BY container_id`
    )
    .bind(pickupAddressId)
    .all<Record<string, unknown>>();
  return {
    address: rowToObj(address),
    customer: rowToObj(customer),
    containers: (cr.results ?? []) as Record<string, unknown>[]
  };
}

export async function getContainerBundleFromD1(
  db: D1Database,
  containerId: number
): Promise<ContainerBundle | null> {
  const container = await db
    .prepare(
      `SELECT container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, event_code, gps_locked,
              latitude, longitude, enabled, location_address, city, state, zip, container_note, ud_cost_share_ud,
              ud_enclosure_doors_ud, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud,
              ud_material_stream_ud, color, service_code_type, service_code_input, service_code, service_date,
              route_ids, frequency_ids, synced_at
       FROM container_snapshot WHERE container_id = ?`
    )
    .bind(containerId)
    .first<Record<string, unknown>>();
  if (!container) {
    return null;
  }
  const paid = container.pickup_address_id as number;
  const address = await db
    .prepare(
      `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
              extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
       FROM address_snapshot WHERE pickup_address_id = ?`
    )
    .bind(paid)
    .first<Record<string, unknown>>();
  if (!address) {
    return {
      container: rowToObj(container),
      address: null,
      customer: null
    };
  }
  const customerId = address.customer_id as number;
  const customer = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
            name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
     FROM customer_snapshot WHERE customer_id = ?`
    )
    .bind(customerId)
    .first<Record<string, unknown>>();
  return {
    container: rowToObj(container),
    address: rowToObj(address),
    customer: rowToObj(customer)
  };
}

export function bundleJsonString(bundle: unknown): string {
  return JSON.stringify(bundle);
}
