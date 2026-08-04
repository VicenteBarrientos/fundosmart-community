export function createLatestRequestGate() {
  let latestTicket = 0;
  return {
    begin() {
      latestTicket += 1;
      return latestTicket;
    },
    isCurrent(ticket) {
      return ticket === latestTicket;
    },
  };
}
