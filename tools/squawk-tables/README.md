# Squawk tables (T24)

Regenerates `packages/core/src/atc/squawk/{eur-cal,faa-nbcap,icao-apac}.ts` from the sources
(docs/06 "Squawk tables"). Python 3 with `xlrd` and `pypdf`; not part of `pnpm check`.

Download into one folder `<dir>`:

| File | Source |
|---|---|
| `cal.xls` | EUROCONTROL CAL, https://www.eurocontrol.int/publication/secondary-surveillance-radar-code-allocation-list-icao-eur-region-cal (v4.13: `eurocontrol-icao-eur-cal-v4-13.xls`) |
| `nbcap.pdf` | FAA Order JO 7110.66H, https://www.faa.gov/documentLibrary/media/Order/2024-04-04_Order_JO_7110.66H_National_Beacon_Code_Allocation_Plan_(NBCAP)_FINAL.pdf |
| `apac-eanp.pdf` | ICAO APAC eANP Vol II, https://www.icao.int/sites/default/files/APAC/APAC-ANP/APAC-new-eANP-Vol-II_July-2026.pdf |
| `VATSpy.dat` | https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/VATSpy.dat |

```
python -I extract.py <dir>
python -I generate.py <dir> ../../packages/core/src/atc/squawk
pnpm lint:fix
```

`extract.py` reads the PDF tables by text position: page numbers and coordinates are those of
the editions above — check them (and the APAC cells against the page images) with a new
edition. Update the version strings, dates and docs/06, then run the squawk tests.
