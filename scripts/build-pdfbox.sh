#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Mozilla Foundation
# Fetch pdfbox-app.jar from Maven Central into ${OUT}/pdfbox/ and build a
# small CheerpJ compatibility patch jar. The harness loads both at runtime
# via CheerpJ (a JVM-on-wasm runtime).
#
# Outputs:
#   ${OUT}/pdfbox/pdfbox-cheerpj-patches.jar
#   ${OUT}/pdfbox/pdfbox-app.jar
#   ${OUT}/pdfbox/pdfbox.jars.json

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OUT="${OUT:-${ROOT}/out}"
SRC_DIR="${SRC_DIR:-${ROOT}/.build-src}"

PDFBOX_VERSION="${PDFBOX_VERSION:-3.0.4}"
PDFBOX_JAVA_RELEASE="${PDFBOX_JAVA_RELEASE:-8}"
JAR_URL="https://repo1.maven.org/maven2/org/apache/pdfbox/pdfbox-app/${PDFBOX_VERSION}/pdfbox-app-${PDFBOX_VERSION}.jar"
PATCH_SRC="${SRC_DIR}/pdfbox-cheerpj-patches-${PDFBOX_VERSION}/src"
PATCH_CLASSES="${SRC_DIR}/pdfbox-cheerpj-patches-${PDFBOX_VERSION}/classes"

command -v javac >/dev/null || {
    echo "pdfbox: javac is required for CheerpJ compatibility patches" >&2
    exit 1
}
command -v jar >/dev/null || {
    echo "pdfbox: jar is required for CheerpJ compatibility patches" >&2
    exit 1
}

mkdir -p "${OUT}/pdfbox"
# Cache the downloaded jar across runs — Maven Central artifacts are
# immutable by version, so the only reason to re-download is a bump.
PDFBOX_JAR_CACHE="${SRC_DIR}/pdfbox-app-${PDFBOX_VERSION}.jar"
mkdir -p "${SRC_DIR}"
if [ ! -f "${PDFBOX_JAR_CACHE}" ]; then
    curl -fSL -o "${PDFBOX_JAR_CACHE}.tmp" "${JAR_URL}"
    expected_sha="$(curl -fsSL "${JAR_URL}.sha1" || true)"
    if [ -n "${expected_sha}" ]; then
        got_sha="$(sha1sum "${PDFBOX_JAR_CACHE}.tmp" | awk '{print $1}')"
        if [ "${got_sha}" != "${expected_sha}" ]; then
            rm -f "${PDFBOX_JAR_CACHE}.tmp"
            echo "pdfbox: sha1 mismatch (got ${got_sha} expected ${expected_sha})" >&2
            exit 1
        fi
    fi
    mv "${PDFBOX_JAR_CACHE}.tmp" "${PDFBOX_JAR_CACHE}"
fi
cp "${PDFBOX_JAR_CACHE}" "${OUT}/pdfbox/pdfbox-app.jar"

rm -rf "${PATCH_SRC}" "${PATCH_CLASSES}"
mkdir -p "${PATCH_SRC}/org/apache/pdfbox/pdmodel/graphics/color" "${PATCH_CLASSES}"

cat > "${PATCH_SRC}/org/apache/pdfbox/pdmodel/graphics/color/PDDeviceCMYK.java" <<'EOF'
package org.apache.pdfbox.pdmodel.graphics.color;

import java.awt.image.BufferedImage;
import java.awt.image.WritableRaster;
import java.io.IOException;

import org.apache.pdfbox.cos.COSName;

public class PDDeviceCMYK extends PDDeviceColorSpace {
    public static PDDeviceCMYK INSTANCE = new PDDeviceCMYK();

    private final PDColor initialColor = new PDColor(new float[] { 0, 0, 0, 1 }, this);

    protected PDDeviceCMYK() {
    }

    public String getName() {
        return COSName.DEVICECMYK.getName();
    }

    public int getNumberOfComponents() {
        return 4;
    }

    public float[] getDefaultDecode(int bitsPerComponent) {
        return new float[] { 0, 1, 0, 1, 0, 1, 0, 1 };
    }

    public PDColor getInitialColor() {
        return initialColor;
    }

    public float[] toRGB(float[] value) throws IOException {
        return cmykToRgb(
            component(value, 0),
            component(value, 1),
            component(value, 2),
            component(value, 3)
        );
    }

    public BufferedImage toRawImage(WritableRaster raster) throws IOException {
        return null;
    }

    public BufferedImage toRGBImage(WritableRaster raster) throws IOException {
        int minX = raster.getMinX();
        int minY = raster.getMinY();
        int width = raster.getWidth();
        int height = raster.getHeight();
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        WritableRaster dest = image.getRaster();
        float[] cmyk = new float[4];
        int[] rgbBytes = new int[3];

        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                raster.getPixel(minX + x, minY + y, cmyk);
                float[] rgb = cmykToRgb(
                    cmyk[0] / 255.0f,
                    cmyk[1] / 255.0f,
                    cmyk[2] / 255.0f,
                    cmyk[3] / 255.0f
                );
                rgbBytes[0] = byteComponent(rgb[0]);
                rgbBytes[1] = byteComponent(rgb[1]);
                rgbBytes[2] = byteComponent(rgb[2]);
                dest.setPixel(x, y, rgbBytes);
            }
        }
        return image;
    }

    private static float[] cmykToRgb(float c, float m, float y, float k) {
        c = normalize(c);
        m = normalize(m);
        y = normalize(y);
        k = normalize(k);
        return new float[] {
            1.0f - Math.min(1.0f, c + k),
            1.0f - Math.min(1.0f, m + k),
            1.0f - Math.min(1.0f, y + k)
        };
    }

    private static float component(float[] values, int index) {
        return values != null && values.length > index ? normalize(values[index]) : 0;
    }

    private static float normalize(float value) {
        if (value > 1.0f) {
            value = value / 255.0f;
        }
        if (value < 0) {
            return 0;
        }
        if (value > 1) {
            return 1;
        }
        return value;
    }

    private static int byteComponent(float value) {
        return Math.max(0, Math.min(255, Math.round(normalize(value) * 255.0f)));
    }
}
EOF

find "${PATCH_SRC}" -name "*.java" -print0 | sort -z \
    | xargs -0 javac --release "${PDFBOX_JAVA_RELEASE}" -encoding UTF-8 \
        -cp "${OUT}/pdfbox/pdfbox-app.jar" \
        -d "${PATCH_CLASSES}"

jar cf "${OUT}/pdfbox/pdfbox-cheerpj-patches.jar" -C "${PATCH_CLASSES}" .

cat > "${OUT}/pdfbox/pdfbox.jars.json" <<'EOF'
{
  "jars": [
    "pdfbox-cheerpj-patches.jar",
    "pdfbox-app.jar"
  ]
}
EOF

cat > "${OUT}/pdfbox/source.json" <<EOF
{
  "name": "pdfbox",
  "artifact": "org.apache.pdfbox:pdfbox-app",
  "version": "${PDFBOX_VERSION}",
  "fingerprint": "pdfbox=${PDFBOX_VERSION}"
}
EOF

echo "pdfbox: ${OUT}/pdfbox ($(du -sh "${OUT}/pdfbox" | cut -f1))"
