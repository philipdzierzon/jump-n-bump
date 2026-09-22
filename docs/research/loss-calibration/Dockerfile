# One-shot netem calibration for #136 §3. See README.md in this directory.
FROM node:22-alpine
RUN apk add --no-cache iproute2 && tc -V
WORKDIR /calibrate
COPY calibrate.mjs ./
CMD ["node", "calibrate.mjs"]
