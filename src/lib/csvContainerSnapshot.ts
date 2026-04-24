import {
  cell,
  emptyToNull,
  mapCsvHeaders,
  parseBool,
  parseCsvLine,
  parseInt10
} from "./csvParse";

export type ContainerSnapshotRow = {
  containerId: number;
  pickupAddressId: number;
  containerTypeId: number | null;
  serialNumber: string | null;
  rfid: string | null;
  onCall: boolean;
  eventCode: string | null;
  gpsLocked: boolean;
  latitude: string | null;
  longitude: string | null;
  enabled: boolean;
  locationAddress: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  containerNote: string | null;
  udCostShareUd: string | null;
  udEnclosureDoorsUd: string | null;
  udLastCompactorInspectionUd: string | null;
  udLastEnclosureInspectionUd: string | null;
  udMaterialStreamUd: string | null;
  color: string | null;
  serviceCodeType: string | null;
  serviceCodeInput: string | null;
  serviceCode: string | null;
  serviceDate: string | null;
  routeIds: string | null;
  frequencyIds: string | null;
};

export function parseContainerSnapshotRow(
  cols: Record<string, number>,
  line: string
): ContainerSnapshotRow | null {
  if (!line.trim()) {
    return null;
  }
  const row = parseCsvLine(line);
  const cid = parseInt10(cell(cols, row, "ContainerID", "containerid"));
  const aid = parseInt10(
    cell(cols, row, "PickupAddressID", "pickupaddressid")
  );
  if (cid === null || aid === null) {
    return null;
  }
  return {
    containerId: cid,
    pickupAddressId: aid,
    containerTypeId: parseInt10(
      cell(cols, row, "ContainerTypeID", "containertypeid")
    ),
    serialNumber: emptyToNull(
      cell(cols, row, "SerialNumber", "serialnumber")
    ),
    rfid: emptyToNull(cell(cols, row, "RFID", "rfid")),
    onCall: parseBool(cell(cols, row, "OnCall", "oncall")),
    eventCode: emptyToNull(cell(cols, row, "EventCode", "eventcode")),
    gpsLocked: parseBool(cell(cols, row, "GPSLocked", "gpslocked")),
    latitude: emptyToNull(cell(cols, row, "Latitude", "latitude")),
    longitude: emptyToNull(cell(cols, row, "Longitude", "longitude")),
    enabled: parseBool(cell(cols, row, "Enabled", "enabled")),
    locationAddress: emptyToNull(
      cell(cols, row, "Address", "address", "locationaddress")
    ),
    city: emptyToNull(cell(cols, row, "City", "city")),
    state: emptyToNull(cell(cols, row, "State", "state")),
    zip: emptyToNull(cell(cols, row, "Zip", "zip")),
    containerNote: emptyToNull(
      cell(cols, row, "ContainerNote", "containernote")
    ),
    udCostShareUd: emptyToNull(
      cell(cols, row, "UD-Cost_Share-UD", "ud-cost_share-ud", "ud_cost_share_ud")
    ),
    udEnclosureDoorsUd: emptyToNull(
      cell(
        cols,
        row,
        "UD-Enclosure_Doors-UD",
        "ud-enclosure_doors-ud",
        "ud_enclosure_doors_ud"
      )
    ),
    udLastCompactorInspectionUd: emptyToNull(
      cell(
        cols,
        row,
        "UD-Last_Compactor_Inspection-UD",
        "ud-last_compactor_inspection-ud"
      )
    ),
    udLastEnclosureInspectionUd: emptyToNull(
      cell(
        cols,
        row,
        "UD-Last_Enclosure_Inspection-UD",
        "ud-last_enclosure_inspection-ud"
      )
    ),
    udMaterialStreamUd: emptyToNull(
      cell(cols, row, "UD-Material_Stream-UD", "ud-material_stream-ud")
    ),
    color: emptyToNull(cell(cols, row, "Color", "color")),
    serviceCodeType: emptyToNull(
      cell(cols, row, "ServiceCodeType", "servicecodetype")
    ),
    serviceCodeInput: emptyToNull(
      cell(cols, row, "ServiceCode_input", "servicecode_input")
    ),
    serviceCode: emptyToNull(
      cell(cols, row, "ServiceCode", "servicecode")
    ),
    serviceDate: emptyToNull(
      cell(cols, row, "ServiceDate", "servicedate")
    ),
    routeIds: emptyToNull(cell(cols, row, "RouteIDs", "routeids")),
    frequencyIds: emptyToNull(
      cell(cols, row, "FrequencyIDs", "frequencyids")
    )
  };
}

export function parseContainerSnapshotCsv(csvText: string): {
  header: string;
  rows: ContainerSnapshotRow[];
} {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    return { header: lines[0] ?? "", rows: [] };
  }
  const header = lines[0];
  const cols = mapCsvHeaders(header);
  const rows: ContainerSnapshotRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = parseContainerSnapshotRow(cols, lines[i]);
    if (r) {
      rows.push(r);
    }
  }
  return { header, rows };
}
