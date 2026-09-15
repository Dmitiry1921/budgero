package application

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog/log"

	"budgero-server/internal/port/driven/external"
	"budgero-server/internal/port/driven/repository"
	"budgero-server/internal/port/driving"
)

// maxRateStaleDays is how far behind a cached rate may lag the requested date
// before a provider refresh is attempted. Mirrors the provider's own walk-back
// window so weekends/gaps resolve without refetch loops.
const maxRateStaleDays = 7

const rateDateLayout = "2006-01-02"

// ExchangeRateService implements driving.ExchangeRateService.
type ExchangeRateService struct {
	rateRepo repository.ExchangeRateRepository
	provider external.CurrencyProvider
}

// NewExchangeRateService creates a new ExchangeRateService.
func NewExchangeRateService(rateRepo repository.ExchangeRateRepository, provider external.CurrencyProvider) *ExchangeRateService {
	return &ExchangeRateService{rateRepo: rateRepo, provider: provider}
}

var _ driving.ExchangeRateService = (*ExchangeRateService)(nil)

// GetRate returns the exchange rate between two currencies on an exact date.
func (s *ExchangeRateService) GetRate(ctx context.Context, baseCurrency, targetCurrency, rateDate string) (float64, error) {
	return s.rateRepo.GetRate(ctx, baseCurrency, targetCurrency, rateDate)
}

// UpsertRate creates or updates an exchange rate for a currency pair and date.
func (s *ExchangeRateService) UpsertRate(ctx context.Context, baseCurrency, targetCurrency, rateDate string, rate float64) error {
	return s.rateRepo.UpsertRate(ctx, baseCurrency, targetCurrency, rateDate, rate)
}

// ListRates returns all exchange rates for a base currency and date.
func (s *ExchangeRateService) ListRates(ctx context.Context, baseCurrency, rateDate string) (map[string]float64, error) {
	return s.rateRepo.ListRates(ctx, baseCurrency, rateDate)
}

// GetOrFetchRates returns base→symbol rates for a date, serving fresh cache
// hits first, fetching missing pairs from the provider, and falling back to
// stale cache entries when the provider is unreachable.
func (s *ExchangeRateService) GetOrFetchRates(ctx context.Context, baseCurrency string, symbols []string, rateDate string) (map[string]float64, error) {
	quotes := make(map[string]float64, len(symbols))
	missing := make([]string, 0)

	for _, sym := range symbols {
		rate, actualDate, err := s.rateRepo.GetLatestRateOnOrBefore(ctx, baseCurrency, sym, rateDate)
		if err == nil && rate != 0 && withinStaleWindow(actualDate, rateDate) {
			quotes[sym] = rate
			continue
		}
		missing = append(missing, sym)
	}

	if len(missing) == 0 {
		return quotes, nil
	}

	if s.provider == nil {
		return quotes, fmt.Errorf("no currency provider configured")
	}

	rates, servedDate, err := s.provider.GetRates(ctx, baseCurrency, rateDate)
	if err != nil {
		// Provider down: serve stale cache entries rather than nothing.
		for _, sym := range missing {
			rate, _, cacheErr := s.rateRepo.GetLatestRateOnOrBefore(ctx, baseCurrency, sym, rateDate)
			if cacheErr == nil && rate != 0 {
				quotes[sym] = rate
			}
		}
		if len(quotes) == 0 {
			return nil, fmt.Errorf("fetching rates for %s on %s: %w", baseCurrency, rateDate, err)
		}
		log.Warn().Err(err).Str("base", baseCurrency).Str("date", rateDate).
			Msg("currency provider unavailable; serving stale cached rates")
		return quotes, nil
	}

	for _, sym := range missing {
		rate, ok := rates[sym]
		if !ok || rate == 0 {
			continue
		}
		if err := s.rateRepo.UpsertRate(ctx, baseCurrency, sym, servedDate, rate); err != nil {
			log.Error().Err(err).Msg("failed upserting exchange rate")
		}
		if err := s.rateRepo.UpsertRate(ctx, sym, baseCurrency, servedDate, 1.0/rate); err != nil {
			log.Warn().Err(err).Msg("failed upserting inverse exchange rate")
		}
		quotes[sym] = rate
	}

	return quotes, nil
}

// RefreshRates bypasses the cache and fetches the requested pairs directly
// from the provider. It is used when a client explicitly asks to replace its
// local daily rate with the latest official dataset.
func (s *ExchangeRateService) RefreshRates(ctx context.Context, baseCurrency string, symbols []string, rateDate string) (map[string]float64, error) {
	if s.provider == nil {
		return nil, fmt.Errorf("no currency provider configured")
	}

	rates, servedDate, err := s.provider.GetRates(ctx, baseCurrency, rateDate)
	if err != nil {
		return nil, fmt.Errorf("refreshing rates for %s on %s: %w", baseCurrency, rateDate, err)
	}

	quotes := make(map[string]float64, len(symbols))
	for _, sym := range symbols {
		rate, ok := rates[sym]
		if !ok || rate == 0 {
			continue
		}
		if err := s.rateRepo.UpsertRate(ctx, baseCurrency, sym, servedDate, rate); err != nil {
			return nil, fmt.Errorf("storing refreshed rate %s/%s: %w", baseCurrency, sym, err)
		}
		if err := s.rateRepo.UpsertRate(ctx, sym, baseCurrency, servedDate, 1.0/rate); err != nil {
			return nil, fmt.Errorf("storing refreshed inverse rate %s/%s: %w", sym, baseCurrency, err)
		}
		quotes[sym] = rate
	}

	return quotes, nil
}

// rateRefreshLookbackDays bounds which cached pairs count as "in use".
const rateRefreshLookbackDays = 35

// RefreshTodayRates re-fetches today's rates for every currency pair seen
// recently, keeping the cache warm for client balance true-ups.
func (s *ExchangeRateService) RefreshTodayRates(ctx context.Context) (int, error) {
	if s.provider == nil {
		return 0, nil
	}
	now := time.Now().UTC()
	today := now.Format(rateDateLayout)
	since := now.AddDate(0, 0, -rateRefreshLookbackDays).Format(rateDateLayout)

	pairs, err := s.rateRepo.ListRecentPairs(ctx, since)
	if err != nil {
		return 0, err
	}

	// One provider call per base covers every target.
	missingByBase := make(map[string][]string)
	for _, pair := range pairs {
		if _, err := s.rateRepo.GetRate(ctx, pair.Base, pair.Target, today); err == nil {
			continue
		}
		missingByBase[pair.Base] = append(missingByBase[pair.Base], pair.Target)
	}

	refreshed := 0
	for base, symbols := range missingByBase {
		rates, servedDate, err := s.provider.GetRates(ctx, base, today)
		if err != nil {
			log.Warn().Err(err).Str("base", base).Msg("rate refresh: provider fetch failed")
			continue
		}
		for _, sym := range symbols {
			rate, ok := rates[sym]
			if !ok || rate == 0 {
				continue
			}
			if err := s.rateRepo.UpsertRate(ctx, base, sym, servedDate, rate); err != nil {
				log.Error().Err(err).Msg("rate refresh: failed upserting rate")
				continue
			}
			refreshed++
		}
	}
	return refreshed, nil
}

func withinStaleWindow(actualDate, requestedDate string) bool {
	actual, err1 := time.Parse(rateDateLayout, actualDate)
	requested, err2 := time.Parse(rateDateLayout, requestedDate)
	if err1 != nil || err2 != nil {
		return false
	}
	return requested.Sub(actual) <= maxRateStaleDays*24*time.Hour
}
