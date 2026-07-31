export const formatBase64 = (data: string, media_type?: string) => {
  if (/^data:[^,]*;base64,/i.test(data)) {
    return data;
  }
  return `data:${media_type || "image/png"};base64,${data}`;
};
