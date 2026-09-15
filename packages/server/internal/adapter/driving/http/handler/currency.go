package handler

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/rs/zerolog/log"
)

// currencyCodePattern bounds what gets forwarded upstream: short uppercase
// alphanumeric tickers (fiat ISO codes and crypto symbols alike).
var currencyCodePattern = regexp.MustCompile(`^[A-Z0-9]{2,10}$`)

// GetExchangeRates proxies and caches daily exchange rates.
// Query params:
// - base: base currency (e.g., USD)
// - symbols: comma-separated list of target currencies (e.g., EUR,GBP,BTC)
// - date: YYYY-MM-DD for daily caching
// - month: YYYY-MM (legacy pre-daily clients; treated as the 1st of the month)
func (h *Handlers) GetExchangeRates(c echo.Context) error {
	base := strings.ToUpper(c.QueryParam("base"))
	symbolsParam := c.QueryParam("symbols")
	date := c.QueryParam("date")
	if date == "" {
		if month := c.QueryParam("month"); month != "" {
			date = month + "-01"
		}
	}

	if base == "" || symbolsParam == "" || date == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "base, symbols and date are required",
		})
	}

	parsed, err := time.Parse("2006-01-02", date)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "date must be YYYY-MM-DD",
		})
	}
	// Clamp future dates (clock-ahead clients) to today's dataset.
	if today := time.Now().UTC().Truncate(24 * time.Hour); parsed.After(today) {
		date = today.Format("2006-01-02")
	}

	if !currencyCodePattern.MatchString(base) {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid base currency code",
		})
	}

	symbols := make([]string, 0)
	for _, s := range strings.Split(symbolsParam, ",") {
		s = strings.TrimSpace(strings.ToUpper(s))
		if s != "" && s != base && currencyCodePattern.MatchString(s) {
			symbols = append(symbols, s)
		}
	}
	if len(symbols) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "no valid symbols provided",
		})
	}

	ctx := c.Request().Context()

	var rates map[string]float64
	if strings.EqualFold(c.QueryParam("refresh"), "true") {
		rates, err = h.services.ExchangeRate.RefreshRates(ctx, base, symbols, date)
	} else {
		rates, err = h.services.ExchangeRate.GetOrFetchRates(ctx, base, symbols, date)
	}
	if err != nil {
		log.Error().Err(err).Str("base", base).Str("date", date).Msg("failed fetching exchange rates")
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "failed to fetch rates"})
	}

	quotes := make(map[string]float64, len(rates))
	for sym, rate := range rates {
		quotes[base+sym] = rate
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"success":   true,
		"source":    base,
		"date":      date,
		"timestamp": time.Now().Unix(),
		"quotes":    quotes,
	})
}
