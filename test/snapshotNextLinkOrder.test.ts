import { describe, expect, it } from "vitest";
import { snapshotNextLink } from "../src/lib/snapshotNextLink";

// Pin raw selector bytes, not just parsed query equality. The sorted group is
// followed by canonical special fields (q/enabled/limit/cursor), not mixed in.
describe("snapshot next-Link alphabetical selector group", () => {
  it("pins every customer selector independently of query insertion order", () => {
    const link = snapshotNextLink("customer", {
      subCustomerNumber: "sub", phone: "phone", customerTypeId: 2,
      customerNumber: "acct", customerId: 1, comments: "note",
      addressZip: "00501", addressState: "AA", addressRouteId: 3,
      addressLastAuditDate: "date", addressFranchiseId: "franchise", addressCity: "city",
      q: "text", enabled: "true", limit: 2
    }, 4);
    expect(link).toBe('</api/v1/customer-snapshot?addressCity=city&addressFranchiseId=franchise&addressLastAuditDate=date&addressRouteId=3&addressState=AA&addressZip=00501&comments=note&customerId=1&customerNumber=acct&customerTypeId=2&phone=phone&subCustomerNumber=sub&q=text&enabled=true&limit=2&cursor=4>; rel="next"');
  });

  it("pins every address selector independently of query insertion order", () => {
    const link = snapshotNextLink("address", {
      zip: "00501", streetAddress: "street", state: "AA", routeId: 3,
      pickupAddressId: 2, owningSubCustomerNumber: "sub", owningCustomerNumber: "acct",
      lastAuditDate: "date", franchiseId: "franchise", driverNote: "note",
      customerId: 1, city: "city", q: "text", enabled: "true", limit: 2
    }, 4);
    expect(link).toBe('</api/v1/address-snapshot?city=city&customerId=1&driverNote=note&franchiseId=franchise&lastAuditDate=date&owningCustomerNumber=acct&owningSubCustomerNumber=sub&pickupAddressId=2&routeId=3&state=AA&streetAddress=street&zip=00501&q=text&enabled=true&limit=2&cursor=4>; rel="next"');
  });

  it("pins every container selector independently of query insertion order", () => {
    const link = snapshotNextLink("container", {
      zip: "00501", syncedSince: "date", state: "AA", serviceCodeType: "type",
      serviceCodeInput: "input", serviceCode: "code", serialNumber: "serial",
      rfid: "tag", pickupAddressId: 2, parentZip: "00502", parentState: "BB",
      parentRouteId: 3, parentFranchiseId: "franchise", parentCity: "parent",
      note: "note", materialStream: "material", locationAddress: "street", eventCode: "event",
      customerId: 1, containerTypeId: 5, containerId: 6, color: "color", city: "city",
      q: "text", enabled: "true", limit: 2
    }, 4);
    expect(link).toBe('</api/v1/container-snapshot?city=city&color=color&containerId=6&containerTypeId=5&customerId=1&eventCode=event&locationAddress=street&materialStream=material&note=note&parentCity=parent&parentFranchiseId=franchise&parentRouteId=3&parentState=BB&parentZip=00502&pickupAddressId=2&rfid=tag&serialNumber=serial&serviceCode=code&serviceCodeInput=input&serviceCodeType=type&state=AA&syncedSince=date&zip=00501&q=text&enabled=true&limit=2&cursor=4>; rel="next"');
  });
});
