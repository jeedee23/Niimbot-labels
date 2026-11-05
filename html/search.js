export function createDrawerFilter(query) {
  const range = /^\s*(\d{1,3})\s*-\s*(\d{1,3})\s*$/.exec(query);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return drawer => Number(drawer.number) >= start && Number(drawer.number) <= end;
  }
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return drawer => {
    const text = [drawer.number, drawer.position, drawer.title, drawer.description, drawer.remark, ...drawer.searchTag].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  };
}
