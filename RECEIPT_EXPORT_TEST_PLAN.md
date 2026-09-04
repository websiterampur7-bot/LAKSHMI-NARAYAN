# Receipt Export Fix Test Plan

## Changes Made

### 1. Frontend (public/index.html)
- ✅ `downloadEstimate()` - Now saves/restores padding and sets `padding: 0` before html2canvas capture
- ✅ `printEstimate()` - Now saves/restores padding and sets `padding: 0` before html2canvas capture
- Effect: Receipt capture now includes ONLY the receipt content, no surrounding padding

### 2. Backend (server.js)
- ✅ PDF export endpoint now uses actual receipt dimensions (billWidth/billHeight in mm)
- ✅ Converts mm to points correctly: billWidth * (72 / 25.4)
- ✅ Calculates height from aspect ratio if not explicitly provided
- ✅ Uses 'left' alignment instead of 'center' to avoid extra margins
- Effect: PDF pages are sized exactly to the receipt, not to predetermined A4/thermal sizes

### 3. PNG Export
- ✅ No changes needed (already captures canvas as-is)
- Benefit: With padding removed, PNG is now tightly cropped

## Test Scenarios

### Test 1: Thermal 58mm Receipt
```
1. Create a test bill (2-3 items)
2. Select "Thermal 58mm" from Bill Size dropdown
3. Tap "Download PNG"
4. Open downloaded PNG in image viewer
5. VERIFY: Image contains ONLY the receipt (no green background, no surrounding whitespace)
6. VERIFY: Image width corresponds to 58mm (no extra pixels on sides)
7. Tap "Download PDF"
8. Open downloaded PDF
9. VERIFY: PDF page is 58mm wide (check page properties)
10. VERIFY: Receipt fills the page with no margins or padding
```

### Test 2: Thermal 80mm Receipt
```
1. Create test bill
2. Select "Thermal 80mm" from Bill Size
3. Tap "Download PNG" → Verify 80mm width, no background
4. Tap "Download PDF" → Verify 80mm page size
```

### Test 3: A4 Receipt
```
1. Create test bill
2. Select "A4" from Bill Size (210mm x 297mm)
3. Tap "Download PNG" → Verify 210mm width, no extra whitespace
4. Tap "Download PDF" → Verify A4 page size (210x297mm)
```

### Test 4: A5 Receipt
```
1. Create test bill
2. Select "A5" (148mm x 210mm)
3. Download PNG & PDF
4. Verify dimensions match A5 spec exactly
```

### Test 5: Custom Receipt Size
```
1. Create test bill
2. Select "Custom"
3. Set width: 100mm, height: 150mm
4. Download PNG → Verify 100mm width, no padding
5. Download PDF → Verify 100x150mm page size
```

### Test 6: Print / SEZNIK Share (iOS)
```
1. Create test bill
2. Select "Thermal 58mm"
3. Tap "Print / Share to SEZNIK" button
4. Observe iOS Share Sheet
5. Select OpenLabel
6. VERIFY: Receipt file arrives without padding/background
7. From OpenLabel, print to SEZNIK 632-L58P
8. VERIFY: Physical receipt prints clean with no surrounding whitespace
```

## Acceptance Criteria

✅ PNG exports contain ONLY receipt content (tightly cropped, no padding)
✅ PNG exports have zero whitespace/background area around receipt
✅ PDF pages are sized to receipt dimensions (not A4 or predetermined sizes)
✅ PDF exports contain receipt filling the entire page
✅ No green background or dashboard elements appear in exports
✅ All receipt sizes (thermal58, thermal80, a6, a5, a4, letter, legal, custom) produce correctly-sized output
✅ SEZNIK 58mm printing workflow receives tightly-cropped image
✅ iOS Share Sheet delivers clean receipt file to OpenLabel

## Visual Comparison

### BEFORE Fix (WRONG)
```
┌────────────────────────────────────┐
│ green background area              │
│ ┌──────────────────────────────┐   │
│ │  Padded Receipt Container    │   │
│ │  ┌──────────────────────────┐│   │
│ │  │ ACTUAL BILL CONTENT      ││   │
│ │  │ receipt data             ││   │
│ │  │ TOTAL                    ││   │
│ │  └──────────────────────────┘│   │
│ │ (18px padding)               │   │
│ └──────────────────────────────┘   │
│ extra space around receipt          │
└────────────────────────────────────┘
```

### AFTER Fix (CORRECT)
```
┌──────────────────────┐
│ ACTUAL BILL CONTENT  │
│ receipt data         │
│ TOTAL                │
└──────────────────────┘
```

## Testing Notes

- Database is not required for export testing (already in UI)
- Test only requires creating a bill in browser and clicking export buttons
- Physical testing on iPhone + OpenLabel + SEZNIK printer recommended after UI verification
- All exports should be validated visually before printing
